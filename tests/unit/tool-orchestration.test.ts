import { describe, expect, it, vi } from 'vitest';

import { executeToolCalls, partitionToolCalls } from '../../src/gateway/tool-orchestration.js';
import type { ChatToolCall, ChatToolDefinition } from '../../src/providers/index.js';

function call(name: string, id: string): ChatToolCall {
  return { id, name, arguments: {} };
}

describe('tool orchestration', () => {
  it('partitions adjacent concurrency-safe calls into bounded parallel batches', () => {
    const toolCalls = [
      call('memphis_recall', '1'),
      call('memphis_search', '2'),
      call('memphis_exec', '3'),
      call('memphis_health', '4'),
    ];
    const tools: ChatToolDefinition[] = [
      { name: 'memphis_recall', description: '', inputSchema: {}, isConcurrencySafe: true },
      { name: 'memphis_search', description: '', inputSchema: {}, isConcurrencySafe: true },
      { name: 'memphis_exec', description: '', inputSchema: {} },
      { name: 'memphis_health', description: '', inputSchema: {}, isConcurrencySafe: true },
    ];

    expect(partitionToolCalls(toolCalls, tools)).toEqual([
      { mode: 'parallel', calls: toolCalls.slice(0, 2) },
      { mode: 'serial', calls: toolCalls.slice(2, 3) },
      { mode: 'parallel', calls: toolCalls.slice(3, 4) },
    ]);
  });

  it('preserves output order while allowing concurrency-safe calls to overlap', async () => {
    const tools: ChatToolDefinition[] = [
      { name: 'memphis_recall', description: '', inputSchema: {}, isConcurrencySafe: true },
      { name: 'memphis_search', description: '', inputSchema: {}, isConcurrencySafe: true },
    ];
    const overlap = { active: 0, max: 0 };
    const resolver = vi.fn(async (toolCall: ChatToolCall) => {
      overlap.active += 1;
      overlap.max = Math.max(overlap.max, overlap.active);
      await new Promise((resolve) => setTimeout(resolve, toolCall.id === '1' ? 25 : 5));
      overlap.active -= 1;
      return JSON.stringify({ id: toolCall.id });
    });

    const results = await executeToolCalls(
      [call('memphis_recall', '1'), call('memphis_search', '2')],
      tools,
      resolver,
      2,
    );

    expect(overlap.max).toBeGreaterThan(1);
    expect(results.map((result) => result.call.id)).toEqual(['1', '2']);
    expect(results.map((result) => result.output)).toEqual([
      JSON.stringify({ id: '1' }),
      JSON.stringify({ id: '2' }),
    ]);
  });

  it('keeps serial tools from overlapping destructive execution', async () => {
    const tools: ChatToolDefinition[] = [
      { name: 'memphis_exec', description: '', inputSchema: {} },
      { name: 'memphis_self_modify', description: '', inputSchema: {} },
    ];
    const overlap = { active: 0, max: 0 };

    await executeToolCalls(
      [call('memphis_exec', '1'), call('memphis_self_modify', '2')],
      tools,
      async (toolCall) => {
        overlap.active += 1;
        overlap.max = Math.max(overlap.max, overlap.active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        overlap.active -= 1;
        return JSON.stringify({ tool: toolCall.name });
      },
      4,
    );

    expect(overlap.max).toBe(1);
  });
});
