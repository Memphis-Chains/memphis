/* eslint-disable no-restricted-syntax */
//
// HTTP server entry — reads MEMPHIS_HTTP_* config (body limit, CORS,
// API token) at server-init time + threads `process.env` through to
// many downstream helpers (CaseChainAdapter, safeModeEnabled, etc.)
// that themselves read via env-registry. The threading reads are the
// shape that the registry rule was meant to encourage; the few direct
// reads are server-startup-config-only. Same rationale as
// cli/index.ts: entry-point materialisation is the canonical place
// for these reads.
//
import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';

import { isAuthRequired } from './auth-policy.js';
import { handleHttpError } from './error-handler.js';
import { globalLimiter, sensitiveLimiter } from './rate-limit.js';
import { registerOperationalConfigRoutes } from './routes/operational-config.js';
import { registerTierCapabilityRoutes } from './routes/tier-capabilities.js';
import { registerVaultRoutes } from './routes/vault.js';
import { readResolvedSecret } from '../config/vault-ref.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerChatCompletionsRoutes } from './routes/chat-completions.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerCognitiveSessionRoutes } from './routes/cognitive-sessions.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerDashboardRoute } from './routes/dashboard.js';
import { registerDecisionRoute } from './routes/decisions.js';
import { registerDualApprovalRoutes } from './routes/dual-approval.js';
import { registerHealthMetricsRoutes } from './routes/health-metrics.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerModelDProposalRoute } from './routes/model-d.js';
import { registerOpsStatusRoute } from './routes/ops-status.js';
import { registerSoulRoutes } from './routes/soul.js';
import { registerStatusRoute } from './routes/status.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { AppError } from '../../core/errors.js';
import { recordSurfaceActivity } from '../../core/surface-presence.js';
import type { ConversationContextService } from '../../gateway/conversation-context-service.js';
import { createInProcessMemoryClient } from '../../gateway/memory-client.js';
import { createInProcessToolExecutor } from '../../gateway/tool-executor.js';
import type { OrchestrationService } from '../../modules/orchestration/service.js';
import { secureCompare } from '../../security/constant-time.js';
import { evaluateFailClosed, allow } from '../../security/fail-closed.js';
import type { AppConfig } from '../config/schema.js';
import { registerWorkerRoutes } from './routes/workers.js';
import type {
  GenerationEventRepository,
  SessionRepository,
} from '../../core/contracts/repository.js';
import { createContextualLogger, type ContextLogger } from '../logging/contextual.js';
import { createLogger } from '../logging/logger.js';
import { metrics } from '../logging/metrics.js';
import { writeSecurityAudit } from '../logging/security-audit.js';
import { resolveInstallRoot } from '../runtime/install-root.js';
import { safeModeEnabled } from '../runtime/safe-mode.js';
import { getSchedulerRuntimeStatus } from '../runtime/scheduler.js';
import { evaluateRevocationCacheStartup } from '../runtime/startup-guards.js';
import { CaseChainAdapter } from '../storage/case-chain-adapter.js';
import type { SqliteAgentPeerRepository } from '../storage/sqlite/repositories/agent-peer-repository.js';
import type { SqliteDualApprovalRepository } from '../storage/sqlite/repositories/dual-approval-repository.js';
import type { SqliteEvolveSessionRepository } from '../storage/sqlite/repositories/evolve-session-repository.js';
import type { SqliteOperatorChatSessionRepository } from '../storage/sqlite/repositories/operator-chat-session-repository.js';
import type { SeenProposalRepository } from '../storage/sqlite/repositories/seen-proposal-repository.js';
import type { SqliteToolPermissionRepository } from '../storage/sqlite/repositories/tool-permission-repository.js';
import type { SqliteWebhookEventRepository } from '../storage/sqlite/repositories/webhook-event-repository.js';
import type { TaskQueueService } from '../storage/task-queue-service.js';
import type { WorkPollingService, WorkerAuthContext } from '../work/work-polling-service.js';

const SENSITIVE_EXACT_ROUTES = new Set<string>([
  '/metrics',
  '/v1/chat/dispatch',
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
const SENSITIVE_PREFIX_ROUTES = ['/v1/sessions/', '/v1/chat/dispatch/'] as const;
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
    evolveSessionRepository?: SqliteEvolveSessionRepository;
    toolPermissionRepository?: SqliteToolPermissionRepository;
    operatorChatSessionRepository?: SqliteOperatorChatSessionRepository;
    conversationContextService?: ConversationContextService;
    workPollingService?: WorkPollingService;
    dualApprovalRepository?: SqliteDualApprovalRepository;
    seenProposalRepository?: SeenProposalRepository;
    webhookEventRepository?: SqliteWebhookEventRepository;
    agentPeerRepository?: SqliteAgentPeerRepository;
    /**
     * Production-safety degraded-boot reasons captured at boot time
     * by `loadConfigDetailed()`. Surfaced via /health.degradedConfig
     * so operators + monitoring see "this daemon is up but degraded"
     * without re-reading logs. Empty/absent on clean boot.
     */
    degradedReasons?: string[];
  },
) {
  const degradedReasons = repos?.degradedReasons ?? [];
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
  // Use the canonical HTTP chat surface key so both memory writes and
  // policy/audit lookups resolve the same row (including any
  // MEMPHIS_SURFACE_HTTP_CHAT_GENERATE_DEFAULT_CONSENT overrides). Other
  // HTTP code paths (chat-work, routes/chat) already use
  // 'http.chat.generate' as the canonical surface name.
  const chatRuntime = {
    memory: createInProcessMemoryClient({ surface: 'http.chat.generate' }),
    toolExecutor: createInProcessToolExecutor({
      surface: 'http.chat.generate',
      evolveSessionRepository: repos?.evolveSessionRepository,
      permissionRepo: repos?.toolPermissionRepository,
      caseAdapter: new CaseChainAdapter(process.env),
      projectRoot: resolveInstallRoot(),
    }),
    operatorChatSessionRepository: repos?.operatorChatSessionRepository,
    conversationContextService: repos?.conversationContextService,
  };

  app.setErrorHandler((error, request, reply) => handleHttpError(error, request, reply));

  // Phase D1 (v1.7.1): same vault-ref filter as Telegram + voice. If
  // MEMPHIS_API_TOKEN was set as `VAULT:memphis_api_token` and the config
  // layer couldn't expand it, comparing the literal "VAULT:..." string to
  // operator's real token would 401 every protected request.
  const apiToken = readResolvedSecret(process.env.MEMPHIS_API_TOKEN) ?? undefined;

  app.addHook('onRequest', async (request, reply) => {
    const contextLogger = createContextualLogger({
      requestId: request.id,
      route: normalizeRoutePath(request.url),
      method: request.method,
      surface: 'http',
    });
    (request as typeof request & { log?: ContextLogger }).log = contextLogger;
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

    const auth = request.headers.authorization;
    if (isWorkerSessionRoute(request.method, routePath)) {
      if (!repos?.workPollingService) {
        return reply.status(503).send({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'work polling not initialized',
            requestId: request.id,
          },
        });
      }
      const token =
        typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      if (!token) {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'worker session token required',
            requestId: request.id,
          },
        });
      }
      try {
        (request as typeof request & { workerAuth?: WorkerAuthContext }).workerAuth =
          repos.workPollingService.authenticateToken(token);
        return;
      } catch (error) {
        const appError =
          error instanceof AppError
            ? error
            : new AppError(
                'PERMISSION_DENIED',
                error instanceof Error ? error.message : 'worker session token invalid',
                401,
              );
        return reply.status(appError.statusCode || 401).send({
          error: {
            code: appError.code,
            message: appError.message,
            requestId: request.id,
          },
        });
      }
    }

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

    recordSurfaceActivity({
      surface: 'http',
      actorId: request.ip ?? 'unknown',
      tier: 2,
    });
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

  registerHealthMetricsRoutes(app, {
    config,
    orchestration,
    workPollingService: repos?.workPollingService,
    degradedReasons,
  });

  registerStatusRoute(app, {
    orchestration,
    agentPeerRepository: repos?.agentPeerRepository,
    workPollingService: repos?.workPollingService,
  });

  registerDashboardRoute(app);
  registerOpsStatusRoute(app, {
    defaultProvider: config.DEFAULT_PROVIDER,
    orchestration,
    taskQueue: repos?.taskQueue,
    workPollingService: repos?.workPollingService,
    dualApprovalRepository: repos?.dualApprovalRepository,
  });

  registerTierCapabilityRoutes(app);

  registerOperationalConfigRoutes(app as never);
  registerVaultRoutes(app as never);
  registerDualApprovalRoutes(app as never, repos?.dualApprovalRepository);
  registerCognitiveSessionRoutes(app as never, config, repos);
  registerSoulRoutes(app as never);
  registerChatRoutes(app as never, orchestration, repos, chatRuntime);
  registerChatCompletionsRoutes(app, orchestration);
  registerConfigRoutes(app);
  registerMemoryRoutes(app);
  registerWebhookRoutes(app, repos?.webhookEventRepository);
  registerAnalyticsRoutes(app, {
    getSchedulerStatus: () =>
      getSchedulerRuntimeStatus(process.env, {
        workPollingTokenReady: repos?.workPollingService?.snapshot().tokenReady ?? null,
      }),
  });
  registerTaskRoutes(app, repos?.taskQueue);
  registerWorkerRoutes(app, repos?.workPollingService, {
    sessionRepository: repos?.sessionRepository,
    generationEventRepository: repos?.generationEventRepository,
    operatorChatSessionRepository: repos?.operatorChatSessionRepository,
  });

  registerModelDProposalRoute(app as never, repos?.seenProposalRepository);
  registerDecisionRoute(app as never);
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

function isWorkerSessionRoute(method: string, routePath: string): boolean {
  if (method !== 'POST') return false;
  return (
    routePath === '/api/workers/refresh' ||
    routePath === '/api/workers/poll' ||
    routePath === '/api/workers/ack' ||
    routePath === '/api/workers/heartbeat' ||
    routePath === '/api/workers/complete'
  );
}

function isSafeModeAllowedRoute(method: string, routePath: string): boolean {
  if (method === 'GET') {
    return (
      routePath === '/health' ||
      routePath === '/v1/providers/health' ||
      routePath === '/v1/metrics' ||
      routePath === '/v1/ops/status' ||
      routePath === '/v1/cognitive/status' ||
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
