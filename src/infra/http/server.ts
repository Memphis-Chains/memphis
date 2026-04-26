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
import { registerWorkerRoutes } from './routes/workers.js';
import { getAppVersion } from '../../config/paths.js';
import type {
  GenerationEventRepository,
  SessionRepository,
} from '../../core/contracts/repository.js';
import { AppError } from '../../core/errors.js';
import {
  formatSurfaceStatusLines,
  getActiveSurfacesSnapshot,
  recordSurfaceActivity,
} from '../../core/surface-presence.js';
import type { ConversationContextService } from '../../gateway/conversation-context-service.js';
import { createInProcessMemoryClient } from '../../gateway/memory-client.js';
import { buildSurfacePolicySnapshot } from '../../gateway/surface-policy.js';
import { createInProcessToolExecutor } from '../../gateway/tool-executor.js';
import type { OrchestrationService } from '../../modules/orchestration/service.js';
import { secureCompare } from '../../security/constant-time.js';
import { evaluateFailClosed, allow } from '../../security/fail-closed.js';
import {
  decryptVaultEntryValue,
  initializeVault,
  listVaultEntryMetadata,
  storeVaultSecret,
  toVaultEntryMetadata,
} from '../../security/vault-boundary.js';
import { setDotEnvValues } from '../config/dotenv-file.js';
import { performHotReload, redactFieldValue } from '../config/hot-reload.js';
import {
  classifyField,
  listKnownFields,
  requiresElevatedTier,
  requiresRestart,
} from '../config/mutability.js';
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
import { envSchema } from '../config/schema.js';
import { createContextualLogger, type ContextLogger } from '../logging/contextual.js';
import { createLogger } from '../logging/logger.js';
import { metrics } from '../logging/metrics.js';
import { writeSecurityAudit } from '../logging/security-audit.js';
import { computeHealthSummary } from '../ops/health-summary.js';
import { verifyAdminActionSignature } from '../runtime/admin-signature.js';
import { writeDualApprovalChainEvent } from '../runtime/dual-approval-events.js';
import { getLocalWorkerRuntimeStatus } from '../runtime/local-worker-state.js';
import { getSchedulerRuntimeStatus } from '../runtime/scheduler.js';
import { evaluateRevocationCacheStartup } from '../runtime/startup-guards.js';
import {
  getBootstrapWarnings,
  getStartupRevocationCacheStatus,
  getStartupQueueResumeStatus,
  getStartupSafeModeNetworkStatus,
  getStartupTrustRootStatus,
} from '../runtime/startup-state.js';
import { snapshotTurnTelemetry } from '../runtime/turn-telemetry.js';
import { checkForUpdate, peekCachedUpdateResult } from '../self-update/github-release.js';
import { CaseChainAdapter } from '../storage/case-chain-adapter.js';
import { getChainAdapterStatus } from '../storage/chain-adapter.js';
import { NapiChainAdapter } from '../storage/rust-chain-adapter.js';
import { getRustEmbedAdapterStatus } from '../storage/rust-embed-adapter.js';
import { VaultAlreadyInitializedError ,
  VaultEntry,
  VaultInitInput,
  getRustVaultAdapterStatus,
} from '../storage/rust-vault-adapter.js';
import { loadReplayBlocksFromChain, normalizeReplayBlocks } from '../storage/soul.js';
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
      projectRoot: process.cwd(),
    }),
    operatorChatSessionRepository: repos?.operatorChatSessionRepository,
    conversationContextService: repos?.conversationContextService,
  };

  app.setErrorHandler((error, request, reply) => handleHttpError(error, request, reply));

  const apiToken = process.env.MEMPHIS_API_TOKEN;

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

  app.get('/health', async (_request, reply) => {
    const payload = await buildHealthPayload(config, process.env, {
      workPolling: repos?.workPollingService?.snapshot() ?? null,
    });
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

  app.get('/v1/providers/models', async () => {
    const models = await orchestration.providersModels();
    return {
      defaultProvider: config.DEFAULT_PROVIDER,
      cascade: orchestration.getCascadeOrder(),
      models,
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

    metrics.observeSchedulerRuntime(
      getSchedulerRuntimeStatus(process.env, {
        workPollingTokenReady: repos?.workPollingService?.snapshot().tokenReady ?? null,
      }),
    );
    metrics.collectChainSnapshot(process.env);
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.send(metrics.toPrometheus());
  });

  app.get('/v1/metrics', async () => {
    metrics.observeSchedulerRuntime(
      getSchedulerRuntimeStatus(process.env, {
        workPollingTokenReady: repos?.workPollingService?.snapshot().tokenReady ?? null,
      }),
    );
    return metrics.snapshot();
  });

  app.get('/api/status', async () => {
    const providers = await orchestration.providersHealth();
    const uptime = Math.floor(process.uptime());
    const chainAdapter = getChainAdapterStatus(process.env);
    const vaultAdapter = getRustVaultAdapterStatus(process.env);
    const embedAdapter = getRustEmbedAdapterStatus(process.env);
    const health = computeHealthSummary({ providers, uptimeSec: uptime });
    const surfacePolicies = buildSurfacePolicySnapshot(process.env);
    const onlinePeers = repos?.agentPeerRepository?.list('online') ?? [];
    const allPeers = repos?.agentPeerRepository?.list() ?? [];
    const workPolling = repos?.workPollingService?.snapshot() ?? null;
    const localWorker = getLocalWorkerRuntimeStatus();
    const scheduler = getSchedulerRuntimeStatus(process.env, {
      workPollingTokenReady: workPolling?.tokenReady ?? null,
    });
    const latestTurnTelemetry = snapshotTurnTelemetry();
    metrics.observeSchedulerRuntime(scheduler);
    const mem = process.memoryUsage();
    return {
      ok: true,
      service: 'memphis',
      version: getAppVersion(),
      uptime,
      uptimeSec: uptime,
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
      },
      agents: { online: onlinePeers.length, total: allPeers.length },
      workPolling,
      localWorker,
      scheduler,
      latestTurnTelemetry,
      health,
      adapters: {
        chain: {
          ...chainAdapter,
          bridgeLoaded: chainAdapter.rustBridgeLoaded,
          loaded: chainAdapter.rustBridgeLoaded,
        },
        vault: vaultAdapter,
        embed: embedAdapter,
      },
      surfacePolicies,
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

    <div class="footer">Memphis v${getAppVersion()} &mdash; <a href="/health" style="color:#60a5fa;">/health</a> &middot; <a href="/v1/providers/health" style="color:#60a5fa;">/v1/providers/health</a> &middot; <a href="/api/status" style="color:#60a5fa;">/api/status</a></div>
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
        <div class="row"><span class="label">Uptime</span><span class="value">\${typeof data.uptimeSec === 'number' ? Math.floor(data.uptimeSec / 60) + 'm ' + (data.uptimeSec % 60) + 's' : 'unknown'}</span></div>
        <div class="row"><span class="label">Status</span><span class="badge \${healthBadge}">\${health.status || 'unknown'}</span></div>
        <div class="row"><span class="label">Local Worker</span><span class="value">\${data.localWorker?.state || 'none'}</span></div>
        <div class="row"><span class="label">Scheduler</span><span class="value">\${data.scheduler?.effectiveTarget || 'local'} (cfg=\${data.scheduler?.configuredTarget || 'local'})</span></div>
      \`;

      // Chain
      const chain = data.adapters?.chain || {};
      const chainLoaded = Boolean(chain.rustBridgeLoaded ?? chain.bridgeLoaded ?? chain.loaded);
      const chainBadge = chainLoaded ? 'badge-ok' : 'badge-err';
      document.getElementById('chain-status').innerHTML = \`
        <div class="row"><span class="label">Bridge</span><span class="badge \${chainBadge}">\${chainLoaded ? 'loaded' : 'not loaded'}</span></div>
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
    // Codex P1 fix (PR #90): kick off a background self-update check on
    // each /status hit. The cache TTL throttles real GitHub fetches to
    // one per cacheTtlMs (default 5 min) and never blocks the response —
    // peekCachedUpdateResult is synchronous and returns null until the
    // first fetch completes. Without this the latestVersion field on
    // /v1/ops/status was permanently null because the cache only got
    // populated by `memphis self-update check`, which runs in a
    // different process from `memphis serve`.
    void checkForUpdate(getAppVersion()).catch(() => {
      // Best-effort: surfaced via the next /status request as `error` on
      // the cached result rather than throwing here.
    });
    const providers = await orchestration.providersHealth();
    const uptimeSec = Math.floor(process.uptime());
    const metricsSnapshot = metrics.snapshot();
    const health = computeHealthSummary({ providers, uptimeSec });
    const chainAdapter = getChainAdapterStatus(process.env);
    const vaultAdapter = getRustVaultAdapterStatus(process.env);
    const queue = repos?.taskQueue?.snapshot() ?? null;
    const workPolling = repos?.workPollingService?.snapshot() ?? null;
    const localWorker = getLocalWorkerRuntimeStatus();
    const scheduler = getSchedulerRuntimeStatus(process.env, {
      workPollingTokenReady: workPolling?.tokenReady ?? null,
    });
    const latestTurnTelemetry = snapshotTurnTelemetry();
    metrics.observeSchedulerRuntime(scheduler);
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
      workPolling,
      localWorker,
      scheduler,
      latestTurnTelemetry,
      startup: {
        queueResume: startupQueueResume,
        safeModeNetwork: startupSafeModeNetwork,
        trustRoot: startupTrustRoot,
        revocationCache: startupRevocationCache,
        warnings: bootstrapWarnings,
      },
      dualApproval,
      activeSurfaces: getActiveSurfacesSnapshot(),
      surfaceStatus: formatSurfaceStatusLines(getActiveSurfacesSnapshot()),
      latestVersion: peekCachedUpdateResult(),
      timestamp: new Date().toISOString(),
    };
  });

  // GET /v1/ops/tier3/sessions — read-only enumeration of active tier-3
  // sessions across surfaces (telegram / tui / matrix / http / cli).
  //
  // Reads the in-process sessions map from src/security/tier3-session.ts.
  // Side effect on read: expired sessions are evicted and audited
  // (mirrors getActiveTier3Session's lazy-eviction policy).
  //
  // Feeds `memphis tier status` and `memphis tier status --json`. CLI
  // is a separate process from the daemon so the only way to see this
  // state is over HTTP.
  app.get('/v1/ops/tier3/sessions', async () => {
    const { listActiveTier3Sessions } = await import('../../security/tier3-session.js');
    const now = Date.now();
    const sessions = listActiveTier3Sessions(process.env).map((s) => ({
      surface: s.surface,
      actorId: s.actorId,
      grantedAt: new Date(s.grantedAt).toISOString(),
      expiresAt: new Date(s.expiresAt).toISOString(),
      remainingMs: Math.max(0, s.expiresAt - now),
    }));
    return {
      ok: true,
      count: sessions.length,
      sessions,
      asOf: new Date(now).toISOString(),
    };
  });

  // GET /v1/ops/capabilities — runtime self-introspection (S3, sprint
  // 2026-04-26). Returns the same payload as the `memphis_self_describe`
  // tool so the operator-facing CLI (`memphis tools list/describe`) and
  // future GUI surfaces share one source of truth. Auth-token gated like
  // the rest of /v1/ops/*.
  app.get('/v1/ops/capabilities', async (request) => {
    const { runMemphisSelfDescribe } = await import('../../mcp/tools/self-describe.js');
    const query = request.query as { surface?: string; actorId?: string } | undefined;
    return runMemphisSelfDescribe(
      { surface: query?.surface, actorId: query?.actorId },
      process.env,
    );
  });

  // POST /v1/ops/tier3/revoke — revoke an active tier-3 session.
  // Body shape:
  //   { surface, actorId } — revoke the specific session (404 if missing)
  //   { all: true }        — revoke every active session (returns count)
  //
  // Auth: MEMPHIS_API_TOKEN (same gate as the GET sister). No operator
  // passphrase needed — revoke is always a *downgrade* from tier 3 and
  // mirrors what TUI / Telegram do for free-text `/tier 0|2`.
  app.post('/v1/ops/tier3/revoke', async (request, reply) => {
    const { listActiveTier3Sessions, revokeTier3Session } = await import(
      '../../security/tier3-session.js'
    );
    const body = (request.body ?? {}) as { surface?: string; actorId?: string; all?: boolean };
    const reason = 'operator-cli-revoke';
    if (body.all === true) {
      const snapshot = listActiveTier3Sessions(process.env);
      let revoked = 0;
      for (const s of snapshot) {
        if (revokeTier3Session(s.surface, s.actorId, reason, process.env)) revoked += 1;
      }
      return { ok: true, revoked, scope: 'all' };
    }
    const validSurfaces = ['tui', 'telegram', 'matrix', 'http', 'cli'] as const;
    if (
      typeof body.surface !== 'string' ||
      typeof body.actorId !== 'string' ||
      !(validSurfaces as readonly string[]).includes(body.surface)
    ) {
      return reply.code(400).send({
        ok: false,
        error:
          'tier3 revoke requires { surface, actorId } (surface ∈ tui|telegram|matrix|http|cli) or { all: true }',
      });
    }
    const wasActive = revokeTier3Session(
      body.surface as (typeof validSurfaces)[number],
      body.actorId,
      reason,
      process.env,
    );
    if (!wasActive) {
      return reply.code(404).send({
        ok: false,
        error: `no active tier-3 session for surface=${body.surface} actorId=${body.actorId}`,
      });
    }
    return { ok: true, revoked: 1, surface: body.surface, actorId: body.actorId };
  });

  // GET /v1/ops/config/show — redacted view of the current hot-reloadable env
  // surface + field classification. Never echoes secret values.
  //
  // Codex P1 fix: when `?key=…` is supplied, it must appear in
  // listKnownFields(). Without the whitelist, an authenticated caller
  // could pass any env var name (e.g. legacy operator-only credentials
  // not tracked in the schema) and the response would echo the value
  // verbatim because redactFieldValue only masks keys it knows are
  // `secret`. This endpoint is for inspecting Memphis runtime config,
  // not arbitrary process.env exfiltration.
  app.get('/v1/ops/config/show', async (request, reply) => {
    const query = request.query as { key?: string } | undefined;
    const known = listKnownFields();
    const knownKeySet = new Set(known.map((k) => k.key));

    if (query?.key !== undefined && !knownKeySet.has(query.key)) {
      return reply.status(400).send({
        ok: false,
        error: `Unknown config key: ${query.key}. /v1/ops/config/show only exposes keys defined in envSchema; use GET /v1/ops/config/show (no key) to list them.`,
        requestedKey: query.key,
      });
    }

    const shownKeys = query?.key ? [query.key] : known.map((k) => k.key);
    const values: Record<string, string> = {};
    for (const key of shownKeys) {
      const raw = process.env[key];
      if (raw === undefined) continue;
      values[key] = redactFieldValue(key, raw);
    }
    return {
      ok: true,
      fields: known,
      values,
      requestedKey: query?.key ?? null,
    };
  });

  // POST /v1/ops/config/set — write a single key/value to `.env` + process.env.
  // Tier-3 elevation is required for secret fields. Cold fields return 409.
  app.post<{ Body: unknown }>('/v1/ops/config/set', async (request, reply) => {
    const schema = envSchema.partial();
    const body = request.body as { key?: unknown; value?: unknown } | undefined;
    const key = typeof body?.key === 'string' ? body.key.trim() : '';
    const value = typeof body?.value === 'string' ? body.value : null;
    if (!key) {
      return reply.status(400).send({ ok: false, error: 'key is required' });
    }
    if (value === null) {
      return reply.status(400).send({ ok: false, error: 'value must be a string' });
    }
    if (value.includes('\n') || value.includes('\r')) {
      return reply.status(400).send({
        ok: false,
        error: 'value must not contain newline characters',
        key,
      });
    }
    if (requiresRestart(key)) {
      writeSecurityAudit({
        action: 'config.set',
        status: 'blocked',
        ip: request.ip,
        route: '/v1/ops/config/set',
        details: { key, reason: 'cold_field' },
      });
      return reply.status(409).send({
        ok: false,
        error: 'cold field — restart required',
        key,
        tier: classifyField(key),
      });
    }
    if (requiresElevatedTier(key)) {
      writeSecurityAudit({
        action: 'config.set',
        status: 'blocked',
        ip: request.ip,
        route: '/v1/ops/config/set',
        details: { key, reason: 'tier3_required' },
      });
      return reply.status(403).send({
        ok: false,
        error: 'secret field — tier-3 elevation required',
        key,
        tier: classifyField(key),
      });
    }
    const candidate = { ...process.env, [key]: value };
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path.includes(key));
      return reply.status(400).send({
        ok: false,
        error: `validation failed: ${issue?.message ?? 'invalid value'}`,
        key,
      });
    }
    setDotEnvValues({ [key]: value }, process.env);
    process.env[key] = value;
    writeSecurityAudit({
      action: 'config.set',
      status: 'allowed',
      ip: request.ip,
      route: '/v1/ops/config/set',
      details: { key, tier: classifyField(key) },
    });
    return {
      ok: true,
      key,
      tier: classifyField(key),
      newValue: redactFieldValue(key, value),
    };
  });

  // POST /v1/ops/restart — tier-3 gated self-restart.
  // Codex P1 (Round 2): HTTP has no tier-3 session elevation flow, so the
  // endpoint requires the operator passphrase in the request body. The
  // MEMPHIS_API_TOKEN gate (see auth-policy) guards who can CALL the
  // endpoint at all; the passphrase is the second factor that authorizes
  // the actual destructive action.
  app.post('/v1/ops/restart', async (request, reply) => {
    const body = (request.body ?? {}) as {
      reason?: unknown;
      passphrase?: unknown;
    };
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const passphrase = typeof body.passphrase === 'string' ? body.passphrase : undefined;

    const { requestRestart } = await import('../runtime/self-restart.js');
    const { validateOperatorPassphrase, loadOperatorConfig } =
      await import('../auth/operator-gate.js');

    let alreadyElevated: boolean;
    let elevatedVia: string;
    if (loadOperatorConfig(process.env)) {
      if (!passphrase) {
        return reply.status(403).send({
          ok: false,
          reason: 'not-elevated' as const,
          message:
            'restart refused — operator passphrase required in request body as `passphrase` field.',
        });
      }
      // Codex P2 (Round 4): validateOperatorPassphrase throws on the
      // attempt rate-limit. Catch so brute-force doesn't surface as a 500.
      try {
        if (!validateOperatorPassphrase(passphrase, process.env)) {
          return reply.status(403).send({
            ok: false,
            reason: 'not-elevated' as const,
            message: 'restart refused — operator passphrase did not validate.',
          });
        }
      } catch (err) {
        return reply.status(403).send({
          ok: false,
          reason: 'not-elevated' as const,
          message: `restart refused — ${err instanceof Error ? err.message : 'passphrase check failed'}`,
        });
      }
      alreadyElevated = true;
      elevatedVia = 'http-passphrase-body';
    } else {
      // Codex P2 (Round 4): first-run — no operator config set yet. HTTP
      // has no session-minting flow, so mark the call as pre-validated.
      // Access is still gated by MEMPHIS_API_TOKEN (see auth-policy).
      alreadyElevated = true;
      elevatedVia = 'http-first-run-no-config';
    }

    const outcome = await requestRestart({
      surface: 'http',
      actorId: request.ip ?? 'unknown',
      reason,
      alreadyElevated,
      elevatedVia,
    });
    if (!outcome.ok) {
      const status = outcome.reason === 'not-elevated' ? 403 : 409;
      return reply.status(status).send(outcome);
    }
    return outcome;
  });

  app.post('/v1/ops/config/reload', async (request, reply) => {
    const result = await performHotReload();
    writeSecurityAudit({
      action: 'config.reload',
      status: result.ok ? 'allowed' : 'blocked',
      ip: request.ip,
      route: '/v1/ops/config/reload',
      details: {
        applied: result.appliedCount,
        rejectedCold: result.rejectedCold,
        validationError: result.validationError,
        envPath: result.envPath,
      },
    });
    if (!result.ok) {
      if (result.validationError) {
        return reply.status(400).send({
          ok: false,
          error: result.validationError,
          result,
        });
      }
      return reply.status(409).send({
        ok: false,
        error: 'reload blocked — restart required for cold fields',
        coldFields: result.rejectedCold,
        result,
      });
    }
    return { ok: true, result };
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
      const out = initializeVault(
        parsed.data,
        { surface: 'http', route: '/v1/vault/init', ip: request.ip },
        process.env,
      );
      return { ok: true, vault: out };
    } catch (error) {
      if (error instanceof VaultAlreadyInitializedError) {
        return reply.status(409).send({
          ok: false,
          error: error.message,
          code: 'VAULT_ALREADY_INITIALIZED',
        });
      }
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
        const saved = storeVaultSecret(
          key,
          plaintext,
          { surface: 'http', route: '/v1/vault/encrypt', ip: request.ip },
          process.env,
        );
        return { ok: true, entry: toVaultEntryMetadata(saved) };
      } catch (error) {
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
      const out = decryptVaultEntryValue(
        parsed.data.entry,
        { surface: 'http', route: '/v1/vault/decrypt', ip: request.ip },
        process.env,
      );
      if (!out.ok) {
        return reply.status(503).send({
          ok: false,
          error: out.error,
        });
      }
      return { ok: true, plaintext: out.plaintext };
    } catch (error) {
      return reply.status(503).send({
        ok: false,
        error: error instanceof Error ? error.message : 'vault_decrypt_failed',
      });
    }
  });

  app.get<{ Querystring: { key?: string } }>('/v1/vault/entries', async (request) => {
    const withIntegrity = listVaultEntryMetadata(
      { surface: 'http', route: '/v1/vault/entries', ip: request.ip },
      process.env,
      request.query?.key,
    );
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

  // ── Cognitive & System Status (for TUI) ─────────────────────────
  app.get('/v1/cognitive/status', async () => {
    const { getCognitiveMode, getCognitiveModeLastModified } =
      await import('../../soul/manifest.js');
    const { getCognitiveModeConfig } = await import('../../cognitive/modes.js');
    const { resolveMaxTokensForStyle } = await import('../../cognitive/mode-dispatch.js');
    const { loadPulseEntries } = await import('../runtime/heartbeat-watchdog.js');
    const { resolveProviderKeyResult } = await import('../../providers/index.js');

    const mode = getCognitiveMode();
    const modeConfig = getCognitiveModeConfig(mode);
    const lastModified = getCognitiveModeLastModified();
    const pulseEntries = loadPulseEntries();
    const lastPulse = pulseEntries.at(-1);
    const chainStatus = getChainAdapterStatus(process.env);
    const vaultStatus = getRustVaultAdapterStatus(process.env);
    const embedStatus = getRustEmbedAdapterStatus(process.env);

    const providerKeys = ['minimax', 'deepseek', 'glm'].map((name) => {
      const result = resolveProviderKeyResult(name);
      return { name, source: result.source };
    });

    return {
      cognitiveMode: {
        active: mode,
        config: {
          name: modeConfig.name,
          description: modeConfig.description,
          temperature: modeConfig.temperature,
          style: modeConfig.style,
          pattern: modeConfig.pattern,
          maxTokens: resolveMaxTokensForStyle(modeConfig.style),
        },
        lastModified,
      },
      availableModes: ['A', 'B', 'C', 'D', 'E'],
      pulse: lastPulse
        ? {
            health: lastPulse.health,
            timestamp: lastPulse.timestamp,
            uptimeSeconds: lastPulse.uptimeSeconds,
          }
        : { health: 'unknown', timestamp: null, uptimeSeconds: 0 },
      defaultProvider: config.DEFAULT_PROVIDER,
      providerKeys,
      adapters: {
        chain: { backend: chainStatus.backend, loaded: chainStatus.rustBridgeLoaded },
        vault: { loaded: vaultStatus.bridgeLoaded, available: vaultStatus.vaultApiAvailable },
        embed: { loaded: embedStatus.bridgeLoaded, available: embedStatus.embedApiAvailable },
      },
      tiers: {
        description: 'Tier 0: no auth, Tier 1: API token, Tier 2: vault passphrase',
        currentTier: config.MEMPHIS_API_TOKEN ? 1 : 0,
      },
    };
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

  registerChatRoutes(app as never, orchestration, repos, chatRuntime);
  registerChatCompletionsRoutes(app, orchestration);
  registerConfigRoutes(app);
  registerMemoryRoutes(app);
  registerWebhookRoutes(app, repos?.webhookEventRepository);
  registerFederationRoutes(app, repos?.agentPeerRepository);
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
