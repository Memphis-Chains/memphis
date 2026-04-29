import { describe, expect, it, vi } from 'vitest';

import { MinimaxProvider } from '../../src/providers/index.js';

/**
 * MiniMax M2.7 sometimes emits agent-mode XML in `content` instead of
 * using the structured tool_calls API. The provider adapter must parse
 * that XML and surface it as ChatToolCall[] so turn-runtime executes
 * the tool. Operator-observed regression on Telegram 2026-04-29.
 */

function mockMinimaxResponse(content: string, toolCalls?: unknown[]): typeof fetch {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  ) as unknown as typeof fetch;
}

describe('MinimaxProvider — inline tool-call XML parser', () => {
  const originalFetch = globalThis.fetch;

  it('extracts <toolcall>…</minimax:tool_call> blocks into structured tool_calls', async () => {
    globalThis.fetch = mockMinimaxResponse(
      [
        '<think>The user said test, run exec</think>',
        '<toolcall>',
        '<invoke name="memphis_exec">',
        '<parameter name="command">echo "hello from exec"</parameter>',
        '</invoke>',
        '</minimax:tool_call>',
      ].join('\n'),
    );
    const provider = new MinimaxProvider({ apiKey: 'test', model: 'MiniMax-M2.7' });
    const res = await provider.chat([{ role: 'user', content: 'test' }]);
    globalThis.fetch = originalFetch;

    expect(res.tool_calls).toHaveLength(1);
    expect(res.tool_calls?.[0].name).toBe('memphis_exec');
    expect(res.tool_calls?.[0].arguments).toEqual({ command: 'echo "hello from exec"' });
    // Block stripped from content
    expect(res.content).not.toContain('<toolcall>');
    expect(res.content).not.toContain('</minimax:tool_call>');
  });

  it('parses multiple parameters in one invoke', async () => {
    globalThis.fetch = mockMinimaxResponse(
      [
        '<toolcall>',
        '<invoke name="memphis_search">',
        '<parameter name="query">test</parameter>',
        '<parameter name="limit">5</parameter>',
        '</invoke>',
        '</minimax:tool_call>',
      ].join('\n'),
    );
    const provider = new MinimaxProvider({ apiKey: 'test', model: 'MiniMax-M2.7' });
    const res = await provider.chat([{ role: 'user', content: 'search' }]);
    globalThis.fetch = originalFetch;

    expect(res.tool_calls?.[0].arguments).toEqual({ query: 'test', limit: '5' });
  });

  it('prefers structured tool_calls over inline XML when both present', async () => {
    globalThis.fetch = mockMinimaxResponse(
      '<toolcall><invoke name="memphis_exec"><parameter name="command">x</parameter></invoke></minimax:tool_call>',
      [
        {
          id: 'call_struct',
          type: 'function',
          function: { name: 'memphis_journal', arguments: '{"content":"y"}' },
        },
      ],
    );
    const provider = new MinimaxProvider({ apiKey: 'test', model: 'MiniMax-M2.7' });
    const res = await provider.chat([{ role: 'user', content: 'go' }]);
    globalThis.fetch = originalFetch;

    expect(res.tool_calls).toHaveLength(1);
    expect(res.tool_calls?.[0].name).toBe('memphis_journal');
  });

  it('passes through plain assistant content unchanged', async () => {
    globalThis.fetch = mockMinimaxResponse('Hello world');
    const provider = new MinimaxProvider({ apiKey: 'test', model: 'MiniMax-M2.7' });
    const res = await provider.chat([{ role: 'user', content: 'hi' }]);
    globalThis.fetch = originalFetch;

    expect(res.content).toBe('Hello world');
    expect(res.tool_calls).toBeUndefined();
  });

  it('drops malformed <toolcall> blocks rather than echoing them', async () => {
    globalThis.fetch = mockMinimaxResponse(
      'before <toolcall>not valid xml</minimax:tool_call> after',
    );
    const provider = new MinimaxProvider({ apiKey: 'test', model: 'MiniMax-M2.7' });
    const res = await provider.chat([{ role: 'user', content: 'x' }]);
    globalThis.fetch = originalFetch;

    expect(res.content).toBe('before  after');
    expect(res.tool_calls).toBeUndefined();
  });
});

describe('MinimaxProvider — system-role coalescing', () => {
  const originalFetch = globalThis.fetch;

  it('merges multiple system messages into a single leading system', async () => {
    let captured: { messages: Array<{ role: string; content: string }> } | undefined;
    globalThis.fetch = (vi.fn(async (_url, init) => {
      captured = JSON.parse((init as RequestInit).body as string);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown) as typeof fetch;

    const provider = new MinimaxProvider({ apiKey: 'test', model: 'MiniMax-M2.7' });
    await provider.chat(
      [
        { role: 'system', content: 'history-system-1' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'history-system-2' },
        { role: 'user', content: 'hey' },
      ],
      { systemPrompt: 'opts-system' },
    );
    globalThis.fetch = originalFetch;

    const sysMessages = captured!.messages.filter((m) => m.role === 'system');
    expect(sysMessages).toHaveLength(1);
    expect(sysMessages[0].content).toContain('opts-system');
    expect(sysMessages[0].content).toContain('history-system-1');
    expect(sysMessages[0].content).toContain('history-system-2');
    // First message MUST be system
    expect(captured!.messages[0].role).toBe('system');
    // No system role in trailing messages
    const trailingSystem = captured!.messages.slice(1).filter((m) => m.role === 'system');
    expect(trailingSystem).toHaveLength(0);
  });

  it('omits system message entirely when no system pieces present', async () => {
    let captured: { messages: Array<{ role: string }> } | undefined;
    globalThis.fetch = (vi.fn(async (_url, init) => {
      captured = JSON.parse((init as RequestInit).body as string);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown) as typeof fetch;

    const provider = new MinimaxProvider({ apiKey: 'test', model: 'MiniMax-M2.7' });
    await provider.chat([{ role: 'user', content: 'hi' }]);
    globalThis.fetch = originalFetch;

    expect(captured!.messages.filter((m) => m.role === 'system')).toHaveLength(0);
  });
});
