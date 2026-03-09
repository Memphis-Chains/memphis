import { randomUUID } from 'node:crypto';
import { AppError } from '../../../core/errors.js';
import { chatGenerateSchema } from '../../config/request-schemas.js';
import { generateResponseSchema } from '../contracts.js';
import type { OrchestrationService } from '../../../modules/orchestration/service.js';
import type {
  GenerationEventRepository,
  SessionRepository,
} from '../../../core/contracts/repository.js';

type ChatRouteRequest = {
  body: unknown;
  id: string;
};

type ChatRouteApp = {
  post: (path: string, handler: (request: ChatRouteRequest) => Promise<unknown>) => void;
};

export async function registerChatRoutes(
  app: ChatRouteApp,
  orchestration: OrchestrationService,
  repos?: { sessionRepository: SessionRepository; generationEventRepository: GenerationEventRepository },
) {
  app.post('/v1/chat/generate', async (request) => {
    const parsed = chatGenerateSchema.safeParse(request.body);

    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid request payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    const payload = parsed.data;

    if (repos && payload.sessionId) {
      repos.sessionRepository.ensureSession(payload.sessionId);
    }

    const result = await orchestration.generate({
      input: payload.input,
      provider: payload.provider,
      model: payload.model,
      sessionId: payload.sessionId,
      options: payload.options,
      strategy: payload.strategy,
    });

    if (repos) {
      repos.generationEventRepository.create({
        id: result.id || `gen_${randomUUID()}`,
        sessionId: payload.sessionId,
        providerUsed: result.providerUsed,
        modelUsed: result.modelUsed,
        timingMs: result.timingMs,
        requestId: request.id,
      });
    }

    const contractCheck = generateResponseSchema.safeParse(result);
    if (!contractCheck.success) {
      throw new AppError('INTERNAL_ERROR', 'Invalid generate response contract', 500, {
        issues: contractCheck.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    return contractCheck.data;
  });
}
