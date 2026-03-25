import { randomUUID } from 'node:crypto';


import Fastify from 'fastify';

import { isAuthRequired } from './auth-policy.js';
import { handleHttpError } from './error-handler.js';
import { buildHealthPayload } from './health.js';
import { globalLimiter, sensitiveLimiter } from './rate-limit.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerChatCompletionsRoutes } from './routes/chat-completions.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerFederationRoutes } from './routes/federation.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { getAppVersion } from '../../config/paths.js';
import type {
  GenerationEventRepository,
  SessionRepository,
} from '../../core/contracts/repository.js';
import { AppError } from '../../core/errors.js';
import type { OrchestrationService } from '../../modules/orchestration/service.js';
import { secureCompare } from '../../security/constant-time.js';
import { evaluateFailClosed, allow } from '../../security/fail-closed.js';
import {
  dualApprovalApproveSchema,
  dualApprovalCancelSchema,
  dualApprovalRequestSchema,
  modelDProposalSchema,
  soulLoopStepSchema,
  soulReplaySchema,
  vaultDecryptSchema,
  vaultEncryptSchema,
  vaultInitSchema,
} from '../config/request-schemas.js';
import type { AppConfig } from '../config/schema.js';
import { createLogger } from '../logging/logger.js';
import { metrics } from '../logging/metrics.js';
import { writeSecurityAudit } from '../logging/security-audit.js';
import { computeHealthSummary } from '../ops/health-summary.js';
import { verifyAdminActionSignature } from '../runtime/admin-signature.js';
import { writeDualApprovalChainEvent } from '../runtime/dual-approval-events.js';
import { evaluateRevocationCacheStartup } from '../runtime/startup-guards.js';
import {
  getBootstrapWarnings,
  getStartupRevocationCacheStatus,
  getStartupQueueResumeStatus,
  getStartupSafeModeNetworkStatus,
  getStartupTrustRootStatus,
} from '../runtime/startup-state.js';
import { getChainAdapterStatus } from '../storage/chain-adapter.js';
import { NapiChainAdapter } from '../storage/rust-chain-adapter.js';
import { getRustEmbedAdapterStatus } from '../storage/rust-embed-adapter.js';
import {
  VaultEntry,
  VaultInitInput,
  getRustVaultAdapterStatus,
  vaultDecrypt,
  vaultEncrypt,
  vaultInit,
} from '../storage/rust-vault-adapter.js';
import { loadReplayBlocksFromChain, normalizeReplayBlocks } from '../storage/soul.js';
import type { SqliteAgentPeerRepository } from '../storage/sqlite/repositories/agent-peer-repository.js';
import type { SqliteDualApprovalRepository } from '../storage/sqlite/repositories/dual-approval-repository.js';
import type { SeenProposalRepository } from '../storage/sqlite/repositories/seen-proposal-repository.js';
import type { SqliteWebhookEventRepository } from '../storage/sqlite/repositories/webhook-event-repository.js';
import type { TaskQueueService } from '../storage/task-queue-service.js';
import {
  listVaultEntries,
  saveVaultEntry,
  verifyVaultEntry,
} from '../storage/vault-entry-store.js';

const SENSITIVE_EXACT_ROUTES = new Set<string>([
  '/metrics',
  '/api/model-d/proposals',
  '/v1/chat/generate',
  '/v1/metrics',
  '/v1/ops/status',
  '/v1/sessions',
  '/v1/vault/init',
  '/v1/vault/encrypt',
  '/v1/vault/decrypt',
  '/v1/vault/entries',
  '/v1/soul/replay',
  '/v1/soul/loop-step',
]);
const SENSITIVE_PREFIX_ROUTES = ['/v1/sessions/'] as const;
const REVOCATION_FAIL_CLOSED_ROUTES = new Set<string>([
  '/v1/admin/dual-approval/request',
  '/v1/admin/dual-approval/approve',
  '/v1/admin/dual-approval/cancel',
  '/v1/vault/init',
  '/v1/vault/encrypt',
  '/v1/vault/decrypt',
]);

export function createHttpServer(
  config: AppConfig,
  orchestration: OrchestrationService,
  repos?: {
    sessionRepository: SessionRepository;
    generationEventRepository: GenerationEventRepository;
    taskQueue?: TaskQueueService;
    dualApprovalRepository?: SqliteDualApprovalRepository;
    seenProposalRepository?: SeenProposalRepository;
    webhookEventRepository?: SqliteWebhookEventRepository;
    agentPeerRepository?: SqliteAgentPeerRepository;
  },
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
    reply.header(
      'Access-Control-Allow-Origin',
      process.env.MEMPHIS_HTTP_CORS_ORIGIN ?? 'http://localhost:3000',
    );
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

    const routePath = normalizeRoutePath(request.url);
    if (safeModeEnabled(process.env) && !isSafeModeAllowedRoute(request.method, routePath)) {
      metrics.recordSafeModeDenial(request.method, routePath);
      return reply.status(403).send({
        error: {
          code: 'PERMISSION_DENIED',
          message: 'forbidden in safe mode',
          details: { route: routePath, method: request.method },
          requestId: request.id,
        },
      });
    }
    if (isRevocationFailClosedRoute(request.method, routePath)) {
      const revocationStatus = evaluateRevocationCacheStartup(process.env);
      if (revocationStatus.enabled && revocationStatus.stale) {
        writeSecurityAudit({
          action: 'revocation.cache.guard',
          status: 'blocked',
          ip: request.ip,
          route: routePath,
          details: {
            reason: revocationStatus.reason ?? 'revocation cache stale',
            maxStaleMs: revocationStatus.maxStaleMs,
            ageMs: revocationStatus.ageMs,
          },
        });
        return reply.status(503).send({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'high-risk route blocked: revocation cache stale',
            details: {
              route: routePath,
              method: request.method,
              reason: revocationStatus.reason ?? 'revocation cache stale',
            },
            requestId: request.id,
          },
        });
      }
    }
    const requiresAuth = isAuthRequired(request.method, routePath);
    const key = `${request.ip}:${request.method}:${routePath}`;
    if (isSensitiveRoute(routePath)) {
      sensitiveLimiter.check(key);
    }

    if (!requiresAuth) return;

    if (!apiToken) {
      // Fail-closed: missing token = error condition → deny via fail-closed evaluation
      const result = evaluateFailClosed('error', 'MEMPHIS_API_TOKEN not set');
      writeSecurityAudit({
        action: 'auth.token.missing',
        status: 'blocked',
        ip: request.ip,
        route: routePath,
        details: { reason: result.reason },
      });
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'MEMPHIS_API_TOKEN not configured — set it to enable authenticated routes',
          details: { reason: result.reason },
          requestId: request.id,
        },
      });
    }

    const auth = request.headers.authorization;
    if (!auth || !secureCompare(auth, `Bearer ${apiToken}`)) {
      // Fail-closed: invalid token = explicit deny via fail-closed evaluation
      const result = evaluateFailClosed('deny', 'invalid bearer token');
      writeSecurityAudit({
        action: 'auth.token.invalid',
        status: 'blocked',
        ip: request.ip,
        route: routePath,
        details: { reason: result.reason },
      });
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'unauthorized',
          details: { reason: result.reason },
          requestId: request.id,
        },
      });
    }

    // Auth passed → allow under fail-closed semantics
    allow('authorized');
  });

  app.addHook('onResponse', async (request, reply) => {
    const reqWithTiming = request as typeof request & { __startedAtMs?: number };
    const startedAtMs = reqWithTiming.__startedAtMs ?? Date.now();
    const durationMs = Date.now() - startedAtMs;
    const routePath = normalizeRoutePath(request.url);
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

  app.get('/api/status', async () => {
    const providers = await orchestration.providersHealth();
    const uptimeSec = Math.floor(process.uptime());
    const chainAdapter = getChainAdapterStatus(process.env);
    const vaultAdapter = getRustVaultAdapterStatus(process.env);
    const embedAdapter = getRustEmbedAdapterStatus(process.env);
    const health = computeHealthSummary({ providers, uptimeSec });
    return {
      ok: true,
      service: 'memphis',
      version: getAppVersion(),
      uptimeSec,
      health,
      adapters: {
        chain: chainAdapter,
        vault: vaultAdapter,
        embed: embedAdapter,
      },
      providers,
      timestamp: new Date().toISOString(),
    };
  });

  const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Memphis — System Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem; }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 1.5rem; color: #f8fafc; }
    h2 { font-size: 0.875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin: 1.5rem 0 0.75rem; }
    .card { background: #1e2330; border: 1px solid #2d3748; border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem; }
    .card-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
    .badge { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
    .badge-ok { background: #052c16; color: #4ade80; }
    .badge-warn { background: #1c1408; color: #facc15; }
    .badge-err { background: #2c0b0e; color: #f87171; }
    .badge-info { background: #0c1a2e; color: #60a5fa; }
    .row { display: flex; justify-content: space-between; align-items: center; padding: 0.25rem 0; border-bottom: 1px solid #1e2330; }
    .row:last-child { border-bottom: none; }
    .label { color: #94a3b8; font-size: 0.875rem; }
    .value { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.875rem; color: #e2e8f0; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    .error-msg { color: #f87171; font-size: 0.875rem; margin-top: 0.25rem; }
    .footer { text-align: center; color: #475569; font-size: 0.75rem; margin-top: 2rem; }
    @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="container">
    <h1>Memphis — System Status</h1>

    <h2>Runtime</h2>
    <div class="card">
      <div id="runtime-status">Loading...</div>
    </div>

    <h2>Adapters</h2>
    <div class="grid">
      <div class="card">
        <div class="card-header">
          <span class="badge badge-info">Chain</span>
        </div>
        <div id="chain-status">Loading...</div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="badge badge-info">Vault</span>
        </div>
        <div id="vault-status">Loading...</div>
      </div>
    </div>

    <h2>Providers</h2>
    <div class="card">
      <div id="providers-status">Loading...</div>
    </div>

    <div class="footer">Memphis v0.4.0 &mdash; <a href="/health" style="color:#60a5fa;">/health</a> &middot; <a href="/v1/providers/health" style="color:#60a5fa;">/v1/providers/health</a> &middot; <a href="/api/status" style="color:#60a5fa;">/api/status</a></div>
  </div>
  <script>
    async function render() {
      let data;
      try {
        const r = await fetch('/api/status');
        data = await r.json();
      } catch(e) {
        document.getElementById('runtime-status').innerHTML = '<span class="badge badge-err">Error</span> <span class="error-msg">Failed to load status: ' + e.message + '</span>';
        return;
      }

      // Runtime
      const health = data.health || {};
      const healthBadge = health.status === 'healthy' ? 'badge-ok' : health.status === 'degraded' ? 'badge-warn' : 'badge-err';
      document.getElementById('runtime-status').innerHTML = \`
        <div class="row"><span class="label">Version</span><span class="value">\${data.version || 'unknown'}</span></div>
        <div class="row"><span class="label">Uptime</span><span class="value">\${data.uptimeSec ? Math.floor(data.uptimeSec / 60) + 'm ' + (data.uptimeSec % 60) + 's' : 'unknown'}</span></div>
        <div class="row"><span class="label">Status</span><span class="badge \${healthBadge}">\${health.status || 'unknown'}</span></div>
      \`;

      // Chain
      const chain = data.adapters?.chain || {};
      const chainBadge = chain.bridgeLoaded ? 'badge-ok' : 'badge-err';
      document.getElementById('chain-status').innerHTML = \`
        <div class="row"><span class="label">Bridge</span><span class="badge \${chainBadge}">\${chain.bridgeLoaded ? 'loaded' : 'not loaded'}</span></div>
        \${chain.error ? '<div class="error-msg">' + chain.error + '</div>' : ''}
      \`;

      // Vault
      const vault = data.adapters?.vault || {};
      const vaultBadge = vault.bridgeLoaded ? 'badge-ok' : 'badge-err';
      document.getElementById('vault-status').innerHTML = \`
        <div class="row"><span class="label">Bridge</span><span class="badge \${vaultBadge}">\${vault.bridgeLoaded ? 'loaded' : 'not loaded'}</span></div>
        \${vault.error ? '<div class="error-msg">' + vault.error + '</div>' : ''}
      \`;

      // Providers
      const providers = data.providers || [];
      if (providers.length === 0) {
        document.getElementById('providers-status').innerHTML = '<span class="label">No providers configured</span>';
      } else {
        document.getElementById('providers-status').innerHTML = providers.map(p => {
          const badge = p.ok ? 'badge-ok' : 'badge-err';
          return '<div class="row"><span class="label">' + p.name + '</span><span class="badge ' + badge + '">' + (p.ok ? 'ok' : 'error') + '</span></div>';
        }).join('');
      }
    }
    render();
    setInterval(render, 30000);
  </script>
</body>
</html>`;

  app.get('/dashboard', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return reply.send(DASHBOARD_HTML);
  });

  app.get('/v1/ops/status', async () => {
    const providers = await orchestration.providersHealth();
    const uptimeSec = Math.floor(process.uptime());
    const metricsSnapshot = metrics.snapshot();
    const health = computeHealthSummary({ providers, uptimeSec });
    const chainAdapter = getChainAdapterStatus(process.env);
    const vaultAdapter = getRustVaultAdapterStatus(process.env);
    const queue = repos?.taskQueue?.snapshot() ?? null;
    const dualApproval = repos?.dualApprovalRepository?.countByState() ?? null;
    const startupQueueResume = getStartupQueueResumeStatus();
    const startupSafeModeEnabled = safeModeEnabled(process.env);
    const startupSafeModeNetwork = getStartupSafeModeNetworkStatus() ?? {
      enabled: startupSafeModeEnabled,
      attempted: false,
      enforced: false,
      backend: startupSafeModeEnabled ? 'iptables' : 'none',
      mode: startupSafeModeEnabled ? 'degraded' : 'disabled',
      reason: startupSafeModeEnabled
        ? 'safe mode network capability not evaluated yet'
        : 'safe mode disabled',
      checkedAt: new Date().toISOString(),
    };
    const startupTrustRoot = getStartupTrustRootStatus();
    const startupRevocationCache = getStartupRevocationCacheStatus();
    const bootstrapWarnings = getBootstrapWarnings();

    return {
      service: 'memphis',
      version: getAppVersion(),
      uptimeSec,
      defaultProvider: config.DEFAULT_PROVIDER,
      providers,
      metrics: metricsSnapshot,
      health,
      adapters: {
        chain: chainAdapter,
        vault: vaultAdapter,
      },
      queue,
      startup: {
        queueResume: startupQueueResume,
        safeModeNetwork: startupSafeModeNetwork,
        trustRoot: startupTrustRoot,
        revocationCache: startupRevocationCache,
        warnings: bootstrapWarnings,
      },
      dualApproval,
      timestamp: new Date().toISOString(),
    };
  });

  app.post<{ Body: VaultInitInput }>('/v1/vault/init', async (request, reply) => {
    const parsed = vaultInitSchema.safeParse(request.body);
    if (!parsed.success) {
      writeSecurityAudit({
        action: 'vault.init',
        status: 'blocked',
        ip: request.ip,
        route: '/v1/vault/init',
        details: { reason: 'invalid_payload' },
      });
      throw new AppError('VALIDATION_ERROR', 'Invalid vault init payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    try {
      const out = vaultInit(parsed.data, process.env);
      writeSecurityAudit({
        action: 'vault.init',
        status: 'allowed',
        ip: request.ip,
        route: '/v1/vault/init',
      });
      return { ok: true, vault: out };
    } catch (error) {
      writeSecurityAudit({
        action: 'vault.init',
        status: 'error',
        ip: request.ip,
        route: '/v1/vault/init',
        details: { message: error instanceof Error ? error.message : 'vault_init_failed' },
      });
      return reply.status(503).send({
        ok: false,
        error: error instanceof Error ? error.message : 'vault_init_failed',
      });
    }
  });

  app.post<{ Body: { key: string; plaintext: string } }>(
    '/v1/vault/encrypt',
    async (request, reply) => {
      const parsed = vaultEncryptSchema.safeParse(request.body);
      if (!parsed.success) {
        writeSecurityAudit({
          action: 'vault.encrypt',
          status: 'blocked',
          ip: request.ip,
          route: '/v1/vault/encrypt',
          details: { reason: 'invalid_payload' },
        });
        throw new AppError('VALIDATION_ERROR', 'Invalid vault encrypt payload', 400, {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.map(String),
            message: i.message,
          })),
        });
      }

      try {
        const { key, plaintext } = parsed.data;
        const out = vaultEncrypt(key, plaintext, process.env);
        const saved = saveVaultEntry(out, process.env);
        writeSecurityAudit({
          action: 'vault.encrypt',
          status: 'allowed',
          ip: request.ip,
          route: '/v1/vault/encrypt',
        });
        return { ok: true, entry: saved };
      } catch (error) {
        writeSecurityAudit({
          action: 'vault.encrypt',
          status: 'error',
          ip: request.ip,
          route: '/v1/vault/encrypt',
          details: { message: error instanceof Error ? error.message : 'vault_encrypt_failed' },
        });
        return reply.status(503).send({
          ok: false,
          error: error instanceof Error ? error.message : 'vault_encrypt_failed',
        });
      }
    },
  );

  app.post<{ Body: { entry: VaultEntry } }>('/v1/vault/decrypt', async (request, reply) => {
    const parsed = vaultDecryptSchema.safeParse(request.body);
    if (!parsed.success) {
      writeSecurityAudit({
        action: 'vault.decrypt',
        status: 'blocked',
        ip: request.ip,
        route: '/v1/vault/decrypt',
        details: { reason: 'invalid_payload' },
      });
      throw new AppError('VALIDATION_ERROR', 'Invalid vault decrypt payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    try {
      const out = vaultDecrypt(parsed.data.entry, process.env);
      writeSecurityAudit({
        action: 'vault.decrypt',
        status: 'allowed',
        ip: request.ip,
        route: '/v1/vault/decrypt',
      });
      return { ok: true, plaintext: out };
    } catch (error) {
      writeSecurityAudit({
        action: 'vault.decrypt',
        status: 'error',
        ip: request.ip,
        route: '/v1/vault/decrypt',
        details: { message: error instanceof Error ? error.message : 'vault_decrypt_failed' },
      });
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
    writeSecurityAudit({
      action: 'vault.entries.read',
      status: 'allowed',
      ip: request.ip,
      route: '/v1/vault/entries',
      details: { count: withIntegrity.length },
    });
    return { ok: true, count: withIntegrity.length, entries: withIntegrity };
  });

  app.post<{ Body: unknown }>('/v1/admin/dual-approval/request', async (request, reply) => {
    const repo = repos?.dualApprovalRepository;
    if (!repo) {
      return reply.status(503).send({ ok: false, error: 'dual approval repository unavailable' });
    }

    const parsed = dualApprovalRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid dual approval request payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    const signatureCheck = verifyAdminActionSignature(
      {
        action: 'dual_approval.request',
        actorId: parsed.data.initiatorId,
        signature: parsed.data.signature,
        payload: {
          action: parsed.data.action,
          ttlMs: parsed.data.ttlMs ?? 5 * 60 * 1000,
          reason: parsed.data.reason ?? null,
        },
      },
      process.env,
    );

    const record = repo.createRequest(parsed.data);
    const transition = repo.listEvents(record.requestId).at(-1);
    if (transition) {
      metrics.recordDualApprovalTransition(record.action, transition.toState);
      await writeDualApprovalChainEvent(
        {
          requestId: record.requestId,
          correlationTaskId: request.id,
          action: record.action,
          fromState: transition.fromState,
          toState: transition.toState,
          actorId: transition.actorId,
          stateVersion: record.stateVersion,
          signatureVerified: signatureCheck.verified,
        },
        process.env,
      );
    }
    writeSecurityAudit({
      action: 'dual_approval.request',
      status: 'allowed',
      ip: request.ip,
      route: '/v1/admin/dual-approval/request',
      details: {
        requestId: record.requestId,
        action: record.action,
        state: record.state,
        signatureVerified: signatureCheck.verified,
      },
    });

    return { ok: true, request: record };
  });

  app.post<{ Body: unknown }>('/v1/admin/dual-approval/approve', async (request, reply) => {
    const repo = repos?.dualApprovalRepository;
    if (!repo) {
      return reply.status(503).send({ ok: false, error: 'dual approval repository unavailable' });
    }

    const parsed = dualApprovalApproveSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid dual approval approve payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    const signatureCheck = verifyAdminActionSignature(
      {
        action: 'dual_approval.approve',
        actorId: parsed.data.approverId,
        signature: parsed.data.signature,
        payload: {
          approvalRequestId: parsed.data.approvalRequestId,
          requestId: parsed.data.requestId,
          expectedStateVersion: parsed.data.expectedStateVersion,
        },
      },
      process.env,
    );

    const eventsBefore = repo.listEvents(parsed.data.requestId).length;
    const record = repo.approve(parsed.data);
    const eventsAfter = repo.listEvents(record.requestId);
    const transition = eventsAfter.length > eventsBefore ? eventsAfter.at(-1) : undefined;
    const replayed = !transition;
    if (transition) {
      metrics.recordDualApprovalTransition(record.action, transition.toState);
      await writeDualApprovalChainEvent(
        {
          requestId: record.requestId,
          correlationTaskId: request.id,
          action: record.action,
          fromState: transition.fromState,
          toState: transition.toState,
          actorId: transition.actorId,
          stateVersion: record.stateVersion,
          signatureVerified: signatureCheck.verified,
        },
        process.env,
      );
    }
    writeSecurityAudit({
      action: 'dual_approval.approve',
      status: 'allowed',
      ip: request.ip,
      route: '/v1/admin/dual-approval/approve',
      details: {
        requestId: record.requestId,
        action: record.action,
        state: record.state,
        stateVersion: record.stateVersion,
        replayed,
        signatureVerified: signatureCheck.verified,
      },
    });

    return { ok: true, request: record, replayed };
  });

  app.post<{ Body: unknown }>('/v1/admin/dual-approval/cancel', async (request, reply) => {
    const repo = repos?.dualApprovalRepository;
    if (!repo) {
      return reply.status(503).send({ ok: false, error: 'dual approval repository unavailable' });
    }

    const parsed = dualApprovalCancelSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid dual approval cancel payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    const signatureCheck = verifyAdminActionSignature(
      {
        action: 'dual_approval.cancel',
        actorId: parsed.data.actorId,
        signature: parsed.data.signature,
        payload: {
          approvalRequestId: parsed.data.approvalRequestId,
          requestId: parsed.data.requestId,
          expectedStateVersion: parsed.data.expectedStateVersion,
        },
      },
      process.env,
    );

    const eventsBefore = repo.listEvents(parsed.data.requestId).length;
    const record = repo.cancel(parsed.data);
    const eventsAfter = repo.listEvents(record.requestId);
    const transition = eventsAfter.length > eventsBefore ? eventsAfter.at(-1) : undefined;
    const replayed = !transition;
    if (transition) {
      metrics.recordDualApprovalTransition(record.action, transition.toState);
      await writeDualApprovalChainEvent(
        {
          requestId: record.requestId,
          correlationTaskId: request.id,
          action: record.action,
          fromState: transition.fromState,
          toState: transition.toState,
          actorId: transition.actorId,
          stateVersion: record.stateVersion,
          signatureVerified: signatureCheck.verified,
        },
        process.env,
      );
    }
    writeSecurityAudit({
      action: 'dual_approval.cancel',
      status: 'allowed',
      ip: request.ip,
      route: '/v1/admin/dual-approval/cancel',
      details: {
        requestId: record.requestId,
        action: record.action,
        state: record.state,
        stateVersion: record.stateVersion,
        replayed,
        signatureVerified: signatureCheck.verified,
      },
    });

    return { ok: true, request: record, replayed };
  });

  app.get<{ Params: { requestId: string } }>(
    '/v1/admin/dual-approval/:requestId',
    async (request) => {
      const repo = repos?.dualApprovalRepository;
      if (!repo) {
        throw new AppError('INTERNAL_ERROR', 'dual approval repository unavailable', 503);
      }

      const record = repo.get(request.params.requestId);
      if (!record) {
        throw new AppError('VALIDATION_ERROR', 'dual approval request not found', 404, {
          requestId: request.params.requestId,
        });
      }

      return {
        ok: true,
        request: record,
        events: repo.listEvents(record.requestId),
      };
    },
  );

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

  app.post<{ Body: unknown }>('/v1/soul/replay', async (request, reply) => {
    const parsed = soulReplaySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid soul replay payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    const chain = parsed.data.chain ?? 'system';
    try {
      const adapter = new NapiChainAdapter(process.env);
      const rawBlocks =
        parsed.data.blocks !== undefined
          ? normalizeReplayBlocks(parsed.data.blocks, chain)
          : await loadReplayBlocksFromChain(chain, process.env);
      const blocks =
        parsed.data.latest && parsed.data.latest > 0
          ? rawBlocks.slice(-parsed.data.latest)
          : rawBlocks;

      const report = adapter.soulReplay(chain, blocks);
      writeSecurityAudit({
        action: 'soul.replay',
        status: 'allowed',
        ip: request.ip,
        route: '/v1/soul/replay',
        details: {
          chain,
          blocks: blocks.length,
          accepted: report.accepted,
          rejected: report.rejected,
        },
      });
      return { ok: true, chain, count: blocks.length, report };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'soul_replay_failed';
      writeSecurityAudit({
        action: 'soul.replay',
        status: 'error',
        ip: request.ip,
        route: '/v1/soul/replay',
        details: { chain, message },
      });
      return reply.status(503).send({ ok: false, error: message });
    }
  });

  app.post<{ Body: unknown }>('/v1/soul/loop-step', async (request, reply) => {
    const parsed = soulLoopStepSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid soul loop-step payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    try {
      const adapter = new NapiChainAdapter(process.env);
      const result = adapter.soulLoopStep(
        parsed.data.state,
        parsed.data.action,
        parsed.data.limits,
      );
      writeSecurityAudit({
        action: 'soul.loop_step',
        status: 'allowed',
        ip: request.ip,
        route: '/v1/soul/loop-step',
        details: {
          applied: result.applied,
          reason: result.reason ?? null,
          haltReason: result.state.halt_reason,
        },
      });
      return { ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'soul_loop_step_failed';
      writeSecurityAudit({
        action: 'soul.loop_step',
        status: 'error',
        ip: request.ip,
        route: '/v1/soul/loop-step',
        details: { message },
      });
      return reply.status(503).send({ ok: false, error: message });
    }
  });

  registerChatRoutes(app, orchestration, repos);
  registerChatCompletionsRoutes(app);
  registerConfigRoutes(app);
  registerMemoryRoutes(app);
  registerWebhookRoutes(app, repos?.webhookEventRepository);
  registerFederationRoutes(app, repos?.agentPeerRepository);
  registerAnalyticsRoutes(app);
  registerTaskRoutes(app, repos?.taskQueue);

  // Model D proposal dedupe window: prevents replayed proposals from creating duplicate chain entries.
  // Each proposal ID is persisted to SQLite so dedup survives restarts; duplicates get a 409 Conflict.
  const DEDUPE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  const seenProposals = repos?.seenProposalRepository;
  // Fallback: in-memory Map when no SQLite repo is available (e.g. tests)
  const modelDSeenProposalsFallback = seenProposals ? null : new Map<string, number>();

  function pruneModelDDedupe(): void {
    if (seenProposals) {
      seenProposals.prune(DEDUPE_WINDOW_MS);
    } else if (modelDSeenProposalsFallback) {
      const cutoff = Date.now() - DEDUPE_WINDOW_MS;
      for (const [id, ts] of modelDSeenProposalsFallback) {
        if (ts < cutoff) modelDSeenProposalsFallback.delete(id);
      }
    }
  }

  function hasSeenProposal(proposalId: string): boolean {
    if (seenProposals) return seenProposals.has(proposalId);
    return modelDSeenProposalsFallback?.has(proposalId) ?? false;
  }

  function recordProposal(proposalId: string): void {
    if (seenProposals) {
      seenProposals.record(proposalId);
    } else {
      modelDSeenProposalsFallback?.set(proposalId, Date.now());
    }
  }

  app.post<{ Body: unknown }>('/api/model-d/proposals', async (request, reply) => {
    const parsed = modelDProposalSchema.safeParse(request.body);
    if (!parsed.success) {
      writeSecurityAudit({
        action: 'model_d.proposal.receive',
        status: 'blocked',
        ip: request.ip,
        route: '/api/model-d/proposals',
        details: { reason: 'invalid_payload' },
      });
      return reply.status(400).send({
        ok: false,
        error: 'invalid model-d proposal payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
      });
    }

    const envelope = parsed.data;
    const configuredAgentId = process.env.MEMPHIS_MODEL_D_AGENT_ID?.trim();
    if (configuredAgentId && envelope.to?.id && envelope.to.id !== configuredAgentId) {
      writeSecurityAudit({
        action: 'model_d.proposal.receive',
        status: 'blocked',
        ip: request.ip,
        route: '/api/model-d/proposals',
        details: {
          reason: 'agent_id_mismatch',
          expectedAgentId: configuredAgentId,
          targetAgentId: envelope.to.id,
        },
      });
      return reply.status(409).send({
        ok: false,
        error: 'proposal target does not match local agent id',
      });
    }

    // Replay protection: reject duplicate proposal IDs within the dedupe window
    pruneModelDDedupe();
    const proposalId = envelope.proposal.id;
    if (hasSeenProposal(proposalId)) {
      writeSecurityAudit({
        action: 'model_d.proposal.receive',
        status: 'blocked',
        ip: request.ip,
        route: '/api/model-d/proposals',
        details: { reason: 'duplicate_proposal', proposalId },
      });
      return reply.status(409).send({
        ok: false,
        error: 'duplicate proposal id — already processed within dedupe window',
        proposalId,
      });
    }
    recordProposal(proposalId);

    const proposalStart = Date.now();
    const vote = chooseModelDVote(envelope.proposal);
    writeSecurityAudit({
      action: 'model_d.proposal.receive',
      status: 'allowed',
      ip: request.ip,
      route: '/api/model-d/proposals',
      details: {
        proposalId: envelope.proposal.id,
        fromAgentId: envelope.from.id,
        vote: vote.choice,
      },
    });

    try {
      const { appendBlock } = await import('../storage/chain-adapter.js');
      const content = `Model D proposal ${envelope.proposal.id} from ${envelope.from.id}: ${envelope.proposal.title}`;
      await appendBlock(
        'collective',
        {
          type: 'model-d-proposal',
          content,
          tags: ['model-d', 'collective', 'proposal', vote.choice],
          proposalId: envelope.proposal.id,
          proposalType: envelope.proposal.type,
          fromAgentId: envelope.from.id,
          targetAgentId: envelope.to?.id ?? null,
          voteChoice: vote.choice,
          voteReason: vote.reason,
        },
        process.env,
      );
    } catch (error) {
      request.log.warn(
        {
          event: 'model_d.proposal.persist_failed',
          proposalId: envelope.proposal.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist model-d proposal vote',
      );
    }

    metrics.recordModelDProposal(vote.choice, Date.now() - proposalStart);

    return {
      ok: true,
      protocol: envelope.protocol,
      proposalId: envelope.proposal.id,
      receiver: {
        id: configuredAgentId || 'memphis-node',
        name: process.env.MEMPHIS_MODEL_D_AGENT_NAME?.trim() || 'Memphis Node',
      },
      vote,
      receivedAt: new Date().toISOString(),
    };
  });

  app.post<{ Body: { title: string; content: string; tags?: string[] } }>(
    '/api/decide',
    async (request, reply) => {
      const { title, content, tags = [] } = request.body || {};
      if (!title || !content || typeof title !== 'string' || typeof content !== 'string') {
        writeSecurityAudit({
          action: 'decision.append',
          status: 'blocked',
          ip: request.ip,
          route: '/api/decide',
          details: { reason: 'title_content_required' },
        });
        return reply.status(400).send({ ok: false, error: 'title and content required' });
      }
      if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
        writeSecurityAudit({
          action: 'decision.append',
          status: 'blocked',
          ip: request.ip,
          route: '/api/decide',
          details: { reason: 'invalid_tags' },
        });
        return reply.status(400).send({ ok: false, error: 'tags must be string[]' });
      }
      try {
        const { appendBlock } = await import('../storage/chain-adapter.js');
        const result = await appendBlock(
          'decision',
          { type: 'decision', title, content, tags },
          process.env,
        );
        writeSecurityAudit({
          action: 'decision.append',
          status: 'allowed',
          ip: request.ip,
          route: '/api/decide',
          details: { index: result.index },
        });
        return { ok: true, index: result.index, hash: result.hash };
      } catch (error) {
        writeSecurityAudit({
          action: 'decision.append',
          status: 'error',
          ip: request.ip,
          route: '/api/decide',
          details: { message: error instanceof Error ? error.message : 'decision_append_failed' },
        });
        return reply.status(503).send({
          ok: false,
          error: error instanceof Error ? error.message : 'decision_append_failed',
        });
      }
    },
  );

  return app;
}

function normalizeRoutePath(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

function isSensitiveRoute(routePath: string): boolean {
  if (SENSITIVE_EXACT_ROUTES.has(routePath)) {
    return true;
  }

  for (const prefix of SENSITIVE_PREFIX_ROUTES) {
    if (routePath.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

function safeModeEnabled(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return (rawEnv.MEMPHIS_SAFE_MODE ?? '').toLowerCase() === 'true';
}

function isSafeModeAllowedRoute(method: string, routePath: string): boolean {
  if (method === 'GET') {
    return (
      routePath === '/health' ||
      routePath === '/v1/providers/health' ||
      routePath === '/v1/metrics' ||
      routePath === '/v1/ops/status' ||
      routePath === '/api/status' ||
      routePath === '/dashboard' ||
      routePath === '/v1/sessions' ||
      routePath.startsWith('/v1/sessions/') ||
      routePath === '/v1/vault/entries'
    );
  }

  return false;
}

function isRevocationFailClosedRoute(method: string, routePath: string): boolean {
  if (method !== 'POST') return false;
  return REVOCATION_FAIL_CLOSED_ROUTES.has(routePath);
}

type ModelDProposalDecisionInput = {
  title: string;
  description: string;
  type: 'strategic' | 'tactical' | 'operational';
  status: 'pending' | 'voting' | 'approved' | 'rejected' | 'executed';
};

type ModelDVoteChoice = 'approve' | 'reject' | 'abstain';

type ModelDVote = {
  choice: ModelDVoteChoice;
  reason: string;
};

const MODEL_D_APPROVE_HINTS = [
  'security',
  'secure',
  'hardening',
  'harden',
  'audit',
  'integrity',
  'stability',
  'latency',
  'benchmark',
  'coverage',
  'test',
  'verification',
  'protect',
];

const MODEL_D_REJECT_HINTS = [
  'disable auth',
  'bypass auth',
  'skip test',
  'skip tests',
  'skip audit',
  'force push',
  'delete branch protection',
  'hardcode secret',
  'plaintext secret',
  'expose key',
];

function chooseModelDVote(input: ModelDProposalDecisionInput): ModelDVote {
  const text = `${input.title} ${input.description}`.toLowerCase();
  if (input.status !== 'pending' && input.status !== 'voting') {
    return {
      choice: 'abstain',
      reason: `proposal status "${input.status}" is not open for voting`,
    };
  }

  if (MODEL_D_REJECT_HINTS.some((needle) => text.includes(needle))) {
    return {
      choice: 'reject',
      reason: 'proposal contains a high-risk operation against security policy',
    };
  }

  if (MODEL_D_APPROVE_HINTS.some((needle) => text.includes(needle))) {
    return {
      choice: 'approve',
      reason: 'proposal aligns with reliability and security priorities',
    };
  }

  if (input.type === 'operational') {
    return {
      choice: 'approve',
      reason: 'operational proposal accepted with standard trust profile',
    };
  }

  return {
    choice: 'abstain',
    reason: 'insufficient signal for an automatic vote',
  };
}
