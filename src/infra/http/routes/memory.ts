import { z } from 'zod';

import { AppError } from '../../../core/errors.js';
import { runMemphisJournal } from '../../../mcp/tools/journal.js';
import { runMemphisRecall } from '../../../mcp/tools/recall.js';

const recallBodySchema = z.object({
  query: z.string().min(1),
  userId: z.string().optional(), // passed through for context; not yet used for filtering
  limit: z.number().int().min(1).max(20).optional(),
});

const journalBodySchema = z.object({
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
});

type MemoryRouteApp = {
  post: (path: string, handler: (request: { body: unknown }) => Promise<unknown>) => void;
};

export function registerMemoryRoutes(app: MemoryRouteApp): void {
  app.post('/api/recall', async (request) => {
    const parsed = recallBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid recall payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    const { query, limit } = parsed.data;
    return runMemphisRecall({ query, limit });
  });

  app.post('/api/journal', async (request) => {
    const parsed = journalBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid journal payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    const { content, tags } = parsed.data;
    return runMemphisJournal({ content, tags });
  });
}
