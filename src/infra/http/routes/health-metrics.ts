import type { OrchestrationService } from '../../../modules/orchestration/service.js';
import type { AppConfig } from '../../config/schema.js';
import { metrics } from '../../logging/metrics.js';
import { getSchedulerRuntimeStatus } from '../../runtime/scheduler.js';
import type { WorkPollingService } from '../../work/work-polling-service.js';
import { buildHealthPayload } from '../health.js';

// Route modules deliberately accept the narrow Fastify shape they need. The
// server installs a contextual AppLogger, which is more specific than
// FastifyBaseLogger and otherwise makes generic Fastify instances invariant.
type RouteApp = {
  get: (
    path: string,
    handler: (request: unknown, reply: RouteReply) => Promise<unknown> | unknown,
  ) => unknown;
};

type RouteReply = {
  status: (code: number) => RouteReply;
  header: (name: string, value: string) => RouteReply;
  send: (payload: unknown) => unknown;
};

export function registerHealthMetricsRoutes(
  app: RouteApp,
  options: {
    config: AppConfig;
    orchestration: OrchestrationService;
    workPollingService?: WorkPollingService;
    degradedReasons: string[];
  },
): void {
  app.get('/health', async (_request, reply) => {
    const payload = await buildHealthPayload(options.config, process.env, {
      workPolling: options.workPollingService?.snapshot() ?? null,
      degradedReasons: options.degradedReasons,
    });
    return reply.status(payload.status === 'healthy' ? 200 : 503).send(payload);
  });

  app.get('/v1/providers/health', async () => ({
    defaultProvider: options.config.DEFAULT_PROVIDER,
    providers: await options.orchestration.providersHealth(),
  }));

  app.get('/v1/providers/models', async () => ({
    defaultProvider: options.config.DEFAULT_PROVIDER,
    cascade: options.orchestration.getCascadeOrder(),
    models: await options.orchestration.providersModels(),
  }));

  app.get('/metrics', async (_request, reply) => {
    if (!metrics.metricsEnabled(process.env)) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'metrics endpoint disabled' },
      });
    }
    observeScheduler(options.workPollingService);
    metrics.collectChainSnapshot(process.env);
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.send(metrics.toPrometheus());
  });

  app.get('/v1/metrics', async () => {
    observeScheduler(options.workPollingService);
    return metrics.snapshot();
  });
}

function observeScheduler(workPollingService?: WorkPollingService): void {
  metrics.observeSchedulerRuntime(
    getSchedulerRuntimeStatus(process.env, {
      workPollingTokenReady: workPollingService?.snapshot().tokenReady ?? null,
    }),
  );
}
