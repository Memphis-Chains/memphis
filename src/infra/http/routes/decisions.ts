import type { FastifyInstance } from 'fastify';

import { writeSecurityAudit } from '../../logging/security-audit.js';

export function registerDecisionRoute(app: FastifyInstance): void {
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
        const { appendBlock } = await import('../../storage/chain-adapter.js');
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
}
