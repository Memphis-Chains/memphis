import { z } from 'zod';

import { writeSecurityAudit } from '../../logging/security-audit.js';
import type { SqliteWebhookEventRepository } from '../../storage/sqlite/repositories/webhook-event-repository.js';

const WEBHOOK_DEDUPE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

const webhookIngestSchema = z.object({
  event_id: z.string().min(1).max(200),
  source: z.string().min(1).max(200),
  event_type: z.string().min(1).max(100),
  payload: z.record(z.string(), z.unknown()).optional(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApp = any;

export function registerWebhookRoutes(
  app: AnyApp,
  webhookRepo?: SqliteWebhookEventRepository,
): void {
  // POST /api/webhooks/ingest — receive webhook events with idempotency
  app.post('/api/webhooks/ingest', async (request: AnyApp, reply: AnyApp) => {
    if (!webhookRepo) {
      return reply.status(503).send({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Webhook storage not initialized' },
      });
    }

    const parsed = webhookIngestSchema.safeParse(request.body);
    if (!parsed.success) {
      writeSecurityAudit({
        action: 'webhook.ingest',
        status: 'blocked',
        ip: request.ip as string,
        details: { reason: 'invalid_schema', errors: parsed.error.issues.map((i) => i.message) },
      });
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      });
    }

    const { event_id, source, event_type, payload } = parsed.data;

    // Idempotency check
    if (webhookRepo.has(event_id)) {
      return reply.status(409).send({
        ok: false,
        error: 'duplicate',
        message: `Event ${event_id} already received`,
      });
    }

    // Prune old events
    webhookRepo.prune(WEBHOOK_DEDUPE_WINDOW_MS);

    // Stage the event
    const recorded = webhookRepo.record(
      event_id,
      source,
      event_type,
      JSON.stringify(payload ?? {}),
    );
    if (!recorded) {
      return reply.status(409).send({
        ok: false,
        error: 'duplicate',
        message: `Event ${event_id} already received`,
      });
    }

    writeSecurityAudit({
      action: 'webhook.ingest',
      status: 'allowed',
      ip: request.ip as string,
      details: { event_id, source, event_type },
    });

    return reply.status(202).send({
      ok: true,
      eventId: event_id,
      status: 'pending',
      message: 'Event accepted for processing',
    });
  });

  // GET /api/webhooks/events — list webhook events
  app.get('/api/webhooks/events', async (request: AnyApp, reply: AnyApp) => {
    if (!webhookRepo) {
      return reply.send({ events: [], count: 0 });
    }

    const status = (request.query as Record<string, string | undefined>).status;
    const validStatuses = ['pending', 'processing', 'completed', 'failed'] as const;
    const filteredStatus =
      status && validStatuses.includes(status as (typeof validStatuses)[number])
        ? (status as (typeof validStatuses)[number])
        : undefined;

    const events = filteredStatus
      ? webhookRepo.listByStatus(filteredStatus)
      : [
          ...webhookRepo.listByStatus('pending'),
          ...webhookRepo.listByStatus('processing'),
          ...webhookRepo.listByStatus('failed'),
        ];

    return reply.send({ events, count: events.length });
  });

  // POST /api/webhooks/retry — retry a failed webhook event
  app.post('/api/webhooks/retry', async (request: AnyApp, reply: AnyApp) => {
    if (!webhookRepo) {
      return reply.status(503).send({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Webhook storage not initialized' },
      });
    }

    const body = request.body as { event_id?: string };
    if (!body.event_id) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'event_id required' },
      });
    }

    const retried = webhookRepo.retryFailed(body.event_id);
    if (!retried) {
      return reply.status(404).send({
        ok: false,
        error: 'Event not found, not failed, or max retries exceeded',
      });
    }

    return reply.send({ ok: true, eventId: body.event_id, status: 'pending' });
  });
}
