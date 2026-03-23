/**
 * GET /api/analytics — aggregate runtime analytics from metrics + observability store.
 */

import { metrics } from '../../logging/metrics.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApp = any;

export function registerAnalyticsRoutes(app: AnyApp): void {
  app.get('/api/analytics', async (_request: AnyApp, reply: AnyApp) => {
    const snapshot = metrics.snapshot();
    const uptime = Math.floor(process.uptime());
    const mem = process.memoryUsage();

    return reply.send({
      uptime_seconds: uptime,
      memory: {
        heap_used_mb: Math.round(mem.heapUsed / (1024 * 1024)),
        heap_total_mb: Math.round(mem.heapTotal / (1024 * 1024)),
        rss_mb: Math.round(mem.rss / (1024 * 1024)),
      },
      providers: snapshot.providers,
      ask: snapshot.ask,
      chain: snapshot.chain,
      embeddings: snapshot.embed,
      schedule: snapshot.schedule,
      safe_mode: snapshot.safeMode,
      queue: snapshot.queue,
      dual_approval: snapshot.dualApproval,
      model_d: snapshot.modelD,
    });
  });
}
