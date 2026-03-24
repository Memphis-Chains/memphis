import { z } from 'zod';

import type { Provider, ChatMessage, ChatToolDefinition } from '../../../providers/index.js';
import { resolveProvider, defaultProviderConfig } from '../../../providers/index.js';
import { writeSecurityAudit } from '../../logging/security-audit.js';

const chatMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }),
  z.object({ role: z.literal('user'), content: z.string() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string(),
    tool_calls: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          arguments: z.record(z.string(), z.unknown()),
        }),
      )
      .optional(),
  }),
  z.object({
    role: z.literal('tool'),
    tool_call_id: z.string(),
    content: z.string(),
  }),
]);

const toolDefSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  inputSchema: z.record(z.string(), z.unknown()),
});

const chatCompletionsSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(200),
  system: z.string().max(20000).optional(),
  model: z.string().max(200).optional(),
  tools: z.array(toolDefSchema).max(64).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(32768).optional(),
});

type ChatCompletionsRouteApp = {
  post: (
    path: string,
    handler: (
      request: { body: unknown; ip: string; id: string },
      reply: { status: (code: number) => { send: (body: unknown) => unknown } },
    ) => Promise<unknown>,
  ) => void;
};

let cachedProvider: Provider | null = null;

async function getProvider(): Promise<Provider> {
  if (cachedProvider) return cachedProvider;
  cachedProvider = await resolveProvider(defaultProviderConfig());
  return cachedProvider;
}

export function registerChatCompletionsRoutes(app: ChatCompletionsRouteApp): void {
  app.post('/v1/chat/completions', async (request, reply) => {
    const parsed = chatCompletionsSchema.safeParse(request.body);
    if (!parsed.success) {
      writeSecurityAudit({
        action: 'chat.completions',
        status: 'blocked',
        ip: request.ip,
        route: '/v1/chat/completions',
        details: { reason: 'validation_error', issues: parsed.error.issues.slice(0, 5) },
      });
      return reply.status(400).send({
        ok: false,
        error: 'Invalid request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    const { messages, system, model, tools, temperature, maxTokens } = parsed.data;

    try {
      const provider = await getProvider();
      const started = Date.now();

      const result = await provider.chat(messages as ChatMessage[], {
        model,
        systemPrompt: system,
        tools: tools as ChatToolDefinition[] | undefined,
        temperature,
        maxTokens,
      });

      const timingMs = Date.now() - started;

      writeSecurityAudit({
        action: 'chat.completions',
        status: 'allowed',
        ip: request.ip,
        route: '/v1/chat/completions',
        details: { provider: result.provider, model: result.model, timingMs },
      });

      return reply.status(200).send({
        ok: true,
        content: result.content,
        tool_calls: result.tool_calls,
        model: result.model,
        provider: result.provider,
        usage: result.tokens,
        timingMs,
      });
    } catch (error) {
      writeSecurityAudit({
        action: 'chat.completions',
        status: 'error',
        ip: request.ip,
        route: '/v1/chat/completions',
        details: { message: error instanceof Error ? error.message : 'completions_failed' },
      });
      return reply.status(503).send({
        ok: false,
        error: error instanceof Error ? error.message : 'completions_failed',
      });
    }
  });
}
