import type { FastifyInstance } from 'fastify';

import { AppError } from '../../../core/errors.js';
import { soulLoopStepSchema, soulReplaySchema } from '../../config/request-schemas.js';
import { writeSecurityAudit } from '../../logging/security-audit.js';
import { NapiChainAdapter } from '../../storage/rust-chain-adapter.js';
import { loadReplayBlocksFromChain, normalizeReplayBlocks } from '../../storage/soul.js';

export function registerSoulRoutes(app: FastifyInstance): void {
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
}
