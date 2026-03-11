import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { getChainPath } from '../../config/paths.js';
import { AppError } from '../../core/errors.js';
import type { AppConfig } from '../config/schema.js';
import { vaultDecryptSchema, vaultEncryptSchema, vaultInitSchema } from '../config/request-schemas.js';
import { createLogger } from '../logging/logger.js';
import { metrics } from '../logging/metrics.js';
import { isAuthRequired } from './auth-policy.js';
import { globalLimiter, sensitiveLimiter } from './rate-limit.js';
import { computeHealthSummary } from '../ops/health-summary.js';
import { handleHttpError } from './error-handler.js';
import { buildHealthPayload } from './health.js';
import { getChainAdapterStatus } from '../storage/chain-adapter.js';
import {
  getRustVaultAdapterStatus,
  vaultDecrypt,
  vaultEncrypt,
  vaultInit,
  type VaultEntry,
  type VaultInitInput,
} from '../storage/rust-vault-adapter.js';
import { listVaultEntries, saveVaultEntry, verifyVaultEntry } from '../storage/vault-entry-store.js';
import type { OrchestrationService } from '../../modules/orchestration/service.js';
import { registerChatRoutes } from './routes/chat.js';
import { resolveSafeChildPath } from './path-validation.js';
import { writeSecurityAudit } from '../logging/security-audit.js';
import type {
  GenerationEventRepository,
  SessionRepository,
} from '../../core/contracts/repository.js';

const SAFE_CHAIN_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function createHttpServer(
  config: AppConfig,
  orchestration: OrchestrationService,
  repos?: { sessionRepository: SessionRepository; generationEventRepository: GenerationEventRepository },
) {
  const logger = createLogger(config.LOG_LEVEL, config.LOG_FORMAT);

  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: Number(process.env.MEMPHIS_HTTP_BODY_LIMIT_BYTES ?? 1024 * 1024),
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      if (typeof incoming === 'string' && incoming.trim().length > 0) return incoming;
      return randomUUID();
    },
    requestIdHeader: 'x-request-id',
  });

  app.setErrorHandler((error, request, reply) => handleHttpError(error, request, reply));


  const apiToken = process.env.MEMPHIS_API_TOKEN;

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('Access-Control-Allow-Origin', process.env.MEMPHIS_HTTP_CORS_ORIGIN ?? '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-request-id');
    reply.header('Vary', 'Origin');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');

    if (request.method === 'OPTIONS') {
      return reply.status(204).send();
    }

    (request as typeof request & { __startedAtMs?: number }).__startedAtMs = Date.now();

    globalLimiter.check(`${request.ip}:${request.method}`);

    const requiresAuth = isAuthRequired(request.method, request.url.split('?')[0] || request.url);
    const routePath = request.url.split('?')[0] || request.url;
    const key = `${request.ip}:${request.method}:${routePath}`;
    if (
      routePath === '/metrics' ||
      routePath === '/v1/chat/generate' ||
      routePath === '/v1/metrics' ||
      routePath === '/v1/ops/status' ||
      routePath === '/v1/sessions' ||
      routePath.startsWith('/v1/sessions/') ||
      routePath === '/v1/vault/init' ||
      routePath === '/v1/vault/encrypt' ||
      routePath === '/v1/vault/decrypt' ||
      routePath === '/v1/vault/entries'
    ) {
      sensitiveLimiter.check(key);
    }

    if (!requiresAuth) return;

    if (!apiToken) return;

    const auth = request.headers.authorization;
    if (!auth || auth !== `Bearer ${apiToken}`) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'unauthorized',
          details: {},
          requestId: request.id,
        },
      });
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    const reqWithTiming = request as typeof request & { __startedAtMs?: number };
    const startedAtMs = reqWithTiming.__startedAtMs ?? Date.now();
    const durationMs = Date.now() - startedAtMs;
    const routePath = request.url.split('?')[0] || request.url;
    metrics.recordHttpRequest(request.method, routePath, reply.statusCode, durationMs);

    request.log.info(
      {
        event: 'http.request.completed',
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
      },
      'HTTP request completed',
    );
  });

  app.get('/health', async (_request, reply) => {
    const payload = await buildHealthPayload(config, process.env);
    const code = payload.status === 'healthy' ? 200 : 503;
    return reply.status(code).send(payload);
  });

  app.get('/v1/providers/health', async () => {
    const providers = await orchestration.providersHealth();
    return {
      defaultProvider: config.DEFAULT_PROVIDER,
      providers,
    };
  });

  app.get('/metrics', async (_request, reply) => {
    if (!metrics.metricsEnabled(process.env)) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'metrics endpoint disabled',
        },
      });
    }

    metrics.collectChainSnapshot(process.env);
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.send(metrics.toPrometheus());
  });

  app.get('/v1/metrics', async () => {
    return metrics.snapshot();
  });


  app.get('/v1/ops/status', async () => {
    const providers = await orchestration.providersHealth();
    const uptimeSec = Math.floor(process.uptime());
    const metricsSnapshot = metrics.snapshot();
    const health = computeHealthSummary({ providers, uptimeSec });
    const chainAdapter = getChainAdapterStatus(process.env);
    const vaultAdapter = getRustVaultAdapterStatus(process.env);

    return {
      service: 'memphis-v5',
      version: '0.1.0',
      uptimeSec,
      defaultProvider: config.DEFAULT_PROVIDER,
      providers,
      metrics: metricsSnapshot,
      health,
      adapters: {
        chain: chainAdapter,
        vault: vaultAdapter,
      },
      timestamp: new Date().toISOString(),
    };
  });



  app.post<{ Body: VaultInitInput }>('/v1/vault/init', async (request, reply) => {
    const parsed = vaultInitSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid vault init payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    try {
      const out = vaultInit(parsed.data, process.env);
      return { ok: true, vault: out };
    } catch (error) {
      return reply.status(503).send({
        ok: false,
        error: error instanceof Error ? error.message : 'vault_init_failed',
      });
    }
  });

  app.post<{ Body: { key: string; plaintext: string } }>('/v1/vault/encrypt', async (request, reply) => {
    const parsed = vaultEncryptSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid vault encrypt payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    try {
      const { key, plaintext } = parsed.data;
      const out = vaultEncrypt(key, plaintext, process.env);
      const saved = saveVaultEntry(out, process.env);
      return { ok: true, entry: saved };
    } catch (error) {
      return reply.status(503).send({
        ok: false,
        error: error instanceof Error ? error.message : 'vault_encrypt_failed',
      });
    }
  });

  app.post<{ Body: { entry: VaultEntry } }>('/v1/vault/decrypt', async (request, reply) => {
    const parsed = vaultDecryptSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid vault decrypt payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    try {
      const out = vaultDecrypt(parsed.data.entry, process.env);
      return { ok: true, plaintext: out };
    } catch (error) {
      return reply.status(503).send({
        ok: false,
        error: error instanceof Error ? error.message : 'vault_decrypt_failed',
      });
    }
  });

  app.get<{ Querystring: { key?: string } }>('/v1/vault/entries', async (request) => {
    const entries = listVaultEntries(process.env, request.query?.key);
    const withIntegrity = entries.map((entry) => ({
      ...entry,
      integrityOk: verifyVaultEntry(entry),
    }));
    return { ok: true, count: withIntegrity.length, entries: withIntegrity };
  });

  app.get('/v1/sessions', async () => {
    if (!repos) return { sessions: [] };
    const sessions = repos.sessionRepository.listSessions();
    return { sessions };
  });

  app.get<{ Params: { sessionId: string } }>('/v1/sessions/:sessionId/events', async (request) => {
    if (!repos) {
      return { sessionId: request.params.sessionId, events: [] };
    }

    const sessionId = request.params.sessionId;
    const events = repos.generationEventRepository.listBySession(sessionId);
    return { sessionId, events };
  });

  registerChatRoutes(app, orchestration, repos);

  // OpenClaw Memory Layer Integration (V5)
  app.post<{ Body: { content: string; tags?: string[]; chain?: string } }>(
    '/api/journal',
    async (request, reply) => {
      const { content, tags = [] } = request.body || {};
      const chain = request.body?.chain ?? 'journal';
      if (!content || typeof content !== 'string') {
        return reply.status(400).send({ ok: false, error: 'content required' });
      }
      if (!isSafeJournalChainName(chain)) {
        writeSecurityAudit({
          action: 'journal.append',
          status: 'blocked',
          ip: request.ip,
          route: '/api/journal',
          details: { reason: 'invalid_chain_name', chain },
        });
        return reply.status(400).send({ ok: false, error: 'invalid chain name' });
      }
      try {
        const { appendBlock } = await import('../storage/chain-adapter.js');
        const result = await appendBlock(chain, { type: 'journal', content, tags }, process.env);
        writeSecurityAudit({
          action: 'journal.append',
          status: 'allowed',
          ip: request.ip,
          route: '/api/journal',
          details: { chain, index: result.index },
        });
        return { ok: true, index: result.index, hash: result.hash };
      } catch (error) {
        writeSecurityAudit({
          action: 'journal.append',
          status: 'error',
          ip: request.ip,
          route: '/api/journal',
          details: { chain, message: error instanceof Error ? error.message : 'journal_append_failed' },
        });
        return reply.status(503).send({
          ok: false,
          error: error instanceof Error ? error.message : 'journal_append_failed',
        });
      }
    },
  );

  app.post<{ Body: { query: string; chain?: string; limit?: number } }>(
    '/api/recall',
    async (request, reply) => {
      const { query, limit = 10 } = request.body || {};
      if (!query || typeof query !== 'string') {
        return reply.status(400).send({ ok: false, error: 'query required' });
      }
      if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
        return reply.status(400).send({ ok: false, error: 'limit must be between 1 and 100' });
      }
      try {
        const { embedSearch } = await import('../storage/rust-embed-adapter.js');
        const results = await embedSearch(query, limit, process.env);
        return { ok: true, results };
      } catch (error) {
        return reply.status(503).send({
          ok: false,
          error: error instanceof Error ? error.message : 'recall_failed',
        });
      }
    },
  );

  app.post<{ Body: { title: string; content: string; tags?: string[] } }>(
    '/api/decide',
    async (request, reply) => {
      const { title, content, tags = [] } = request.body || {};
      if (!title || !content || typeof title !== 'string' || typeof content !== 'string') {
        return reply.status(400).send({ ok: false, error: 'title and content required' });
      }
      if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
        return reply.status(400).send({ ok: false, error: 'tags must be string[]' });
      }
      try {
        const { appendBlock } = await import('../storage/chain-adapter.js');
        const result = await appendBlock('decision', { type: 'decision', title, content, tags }, process.env);
        return { ok: true, index: result.index, hash: result.hash };
      } catch (error) {
        return reply.status(503).send({
          ok: false,
          error: error instanceof Error ? error.message : 'decision_append_failed',
        });
      }
    },
  );

  return app;
}

function isSafeJournalChainName(chain: unknown): chain is string {
  if (typeof chain !== 'string') {
    return false;
  }

  if (!SAFE_CHAIN_NAME.test(chain.trim())) {
    return false;
  }

  try {
    resolveSafeChildPath(getChainPath(), chain);
    return true;
  } catch {
    return false;
  }
}
