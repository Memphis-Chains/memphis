import type { OrchestrationService } from '../../../modules/orchestration/service.js';
import { writeSecurityAudit } from '../../logging/security-audit.js';

type ChatCompletionsRouteApp = {
  post: (
    path: string,
    handler: (
      request: { body: unknown; ip: string; id: string },
      reply: { status: (code: number) => { send: (body: unknown) => unknown } },
    ) => Promise<unknown>,
  ) => void;
};

export function registerChatCompletionsRoutes(
  app: ChatCompletionsRouteApp,
  _orchestration: OrchestrationService,
): void {
  app.post('/v1/chat/completions', async (request, reply) => {
    writeSecurityAudit({
      action: 'chat.completions',
      status: 'blocked',
      ip: request.ip,
      route: '/v1/chat/completions',
      details: { reason: 'deprecated_endpoint' },
    });

    return reply.status(410).send({
      ok: false,
      error: 'deprecated',
      message:
        'POST /v1/chat/completions has been removed from the Memphis core chat contract; use POST /v1/chat/generate instead.',
      requestId: request.id,
    });
  });
}
