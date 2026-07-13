import type { FastifyInstance } from 'fastify';

import { AppError } from '../../../core/errors.js';
import {
  dualApprovalApproveSchema,
  dualApprovalCancelSchema,
  dualApprovalRequestSchema,
} from '../../config/request-schemas.js';
import { metrics } from '../../logging/metrics.js';
import { writeSecurityAudit } from '../../logging/security-audit.js';
import { verifyAdminActionSignature } from '../../runtime/admin-signature.js';
import { writeDualApprovalChainEvent } from '../../runtime/dual-approval-events.js';
import type { SqliteDualApprovalRepository } from '../../storage/sqlite/repositories/dual-approval-repository.js';

export function registerDualApprovalRoutes(
  app: FastifyInstance,
  repository?: SqliteDualApprovalRepository,
): void {
  app.post<{ Body: unknown }>('/v1/admin/dual-approval/request', async (request, reply) => {
    const repo = repository;
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
    const repo = repository;
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
    const repo = repository;
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
      const repo = repository;
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
}
