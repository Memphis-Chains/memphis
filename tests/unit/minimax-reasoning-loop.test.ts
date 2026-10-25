import { afterEach, describe, expect, it, vi } from 'vitest';

const { appendBlock, recordLocalSpan } = vi.hoisted(() => ({
  appendBlock: vi.fn(async () => undefined),
  recordLocalSpan: vi.fn(),
}));
vi.mock('../../src/infra/storage/chain-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/infra/storage/chain-adapter.js')>()),
  appendBlock,
}));
vi.mock('../../src/infra/observability/console-exporter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/infra/observability/console-exporter.js')>()),
  recordLocalSpan,
}));

import { runAgentLoop } from '../../src/gateway/agent-runtime.js';
import { providerToLlmClient } from '../../src/gateway/provider-adapter.js';
import { MinimaxProvider } from '../../src/providers/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('MiniMax reasoning through the real tool loop', () => {
  it('refuses context growth before the next upstream request without replaying a tool', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: null,
              reasoning_content: 'x'.repeat(3_600_000),
              tool_calls: [
                {
                  id: 'call-once',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const execute = vi.fn(async () => '42');
    await expect(
      runAgentLoop({
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'lookup' }],
        llm: providerToLlmClient(new MinimaxProvider({ apiKey: 'test-key', rawEnv: {} })),
        toolExecutor: {
          listTools: () => [
            { name: 'lookup', description: 'Synthetic lookup', inputSchema: { type: 'object' } },
          ],
          execute,
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', retriable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(appendBlock.mock.calls)).not.toContain('xxxx');
  });

  it.each([true, false])(
    'preserves complete assistant messages across two tool rounds (reasoning=%s)',
    async (withReasoning) => {
      const requests: Array<{
        messages: Array<Record<string, unknown>>;
        reasoning_effort: string;
      }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          requests.push(JSON.parse(init.body as string));
          const turn = requests.length;
          return Response.json({
            choices: [
              {
                message: {
                  content: turn < 3 ? null : 'The lookup returned 42.',
                  ...(withReasoning
                    ? { reasoning_content: `private continuation ${turn}\nąę 🚀` }
                    : {}),
                  ...(turn < 3
                    ? {
                        tool_calls: [
                          {
                            id: `call-${turn}`,
                            type: 'function',
                            function: { name: 'lookup', arguments: JSON.stringify({ step: turn }) },
                          },
                        ],
                      }
                    : {}),
                },
                finish_reason: turn < 3 ? 'tool_calls' : 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        }),
      );
      const execute = vi.fn(async () => '{"value":42}');
      const result = await runAgentLoop({
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'look up twice' }],
        llm: providerToLlmClient(new MinimaxProvider({ apiKey: 'test-key', rawEnv: {} })),
        reasoningEffort: 'low',
        toolExecutor: {
          listTools: () => [
            {
              name: 'lookup',
              description: 'Read a synthetic value',
              inputSchema: {
                type: 'object',
                properties: { step: { type: 'integer' } },
                required: ['step'],
              },
            },
          ],
          execute,
        },
      });
      expect(requests).toHaveLength(3);
      expect(execute.mock.calls).toEqual([
        [{ id: 'call-1', name: 'lookup', arguments: { step: 1 } }],
        [{ id: 'call-2', name: 'lookup', arguments: { step: 2 } }],
      ]);
      expect(requests.every((r) => r.reasoning_effort === 'low')).toBe(true);
      const assistants = requests[2].messages.filter((message) => message.role === 'assistant');
      expect(assistants).toEqual(
        [1, 2].map((turn) => ({
          role: 'assistant',
          content: null,
          ...(withReasoning ? { reasoning_content: `private continuation ${turn}\nąę 🚀` } : {}),
          tool_calls: [
            {
              id: `call-${turn}`,
              type: 'function',
              function: { name: 'lookup', arguments: JSON.stringify({ step: turn }) },
            },
          ],
        })),
      );
      expect(
        requests[2].messages
          .filter((message) => message.role === 'tool')
          .map((message) => message.tool_call_id),
      ).toEqual(['call-1', 'call-2']);
      expect(result.reply).toBe('The lookup returned 42.');
      expect(result.messages.at(-1)).toEqual({
        role: 'assistant',
        content: result.reply,
        ...(withReasoning ? { reasoning_content: 'private continuation 3\nąę 🚀' } : {}),
      });
      expect(result.usage?.totalTokens).toBe(45);
      expect(JSON.stringify(result.messages.map((message) => message.content))).not.toContain(
        'private continuation',
      );
      expect(JSON.stringify(appendBlock.mock.calls)).not.toContain('private continuation');
      expect(JSON.stringify(recordLocalSpan.mock.calls)).not.toContain('private continuation');
    },
  );
});
