/**
 * Sprint 1.3 — anti-confabulation guard end-to-end through runAgentLoop.
 *
 * Verifies the runtime injects a "Tool execution surfaced errors" system
 * message after any tool batch where ≥1 result classifies as error
 * (`{ error }` / `{ ok: false }` / `{ blocked: true }`). This message
 * lands in the workingMessages stream BEFORE the tool messages so the
 * LLM sees explicit "do not claim success" framing alongside the raw
 * tool output in its next turn.
 */

import { describe, expect, it } from 'vitest';

import { runAgentLoop } from '../../src/gateway/agent-runtime.js';
import type { LlmClient, ToolExecutor } from '../../src/gateway/chat-types.js';
import type { ChatToolCall, ChatToolDefinition } from '../../src/providers/index.js';

function makeLlm(turns: Array<{ content: string; tool_calls?: ChatToolCall[] }>): LlmClient {
  let i = 0;
  return {
    async complete() {
      const turn = turns[i] ?? turns[turns.length - 1];
      i += 1;
      return turn;
    },
  };
}

function makeExecutor(handlers: Record<string, () => string>): ToolExecutor {
  const tools: ChatToolDefinition[] = Object.keys(handlers).map((name) => ({
    name,
    description: `${name} (test)`,
    inputSchema: { type: 'object', properties: {} },
  }));
  return {
    listTools: () => tools,
    async execute(call) {
      const handler = handlers[call.name];
      if (!handler) return JSON.stringify({ error: `unknown tool: ${call.name}` });
      return handler();
    },
    maxParallel: 4,
  };
}

describe('sprint 1.3 — honesty guard injection', () => {
  it('injects system message after tool returns { error }', async () => {
    const toolCall: ChatToolCall = {
      id: 'call-1',
      name: 'memphis_exec',
      arguments: {},
    };
    const llm = makeLlm([
      { content: '', tool_calls: [toolCall] },
      { content: 'I cannot run that — PERMISSION_DENIED.' },
    ]);
    const toolExecutor = makeExecutor({
      memphis_exec: () => JSON.stringify({ error: 'PERMISSION_DENIED' }),
    });

    const result = await runAgentLoop({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'run command' }],
      llm,
      toolExecutor,
    });

    const systemMessages = result.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toContain('Tool execution surfaced errors');
    expect(systemMessages[0].content).toContain('memphis_exec');
    expect(systemMessages[0].content).toContain('PERMISSION_DENIED');
  });

  it('injects system message after tool returns { ok: false }', async () => {
    const toolCall: ChatToolCall = { id: 'call-2', name: 'memphis_git', arguments: {} };
    const llm = makeLlm([
      { content: '', tool_calls: [toolCall] },
      { content: 'Nothing to commit.' },
    ]);
    const toolExecutor = makeExecutor({
      memphis_git: () => JSON.stringify({ ok: false, reason: 'nothing staged' }),
    });

    const result = await runAgentLoop({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'commit' }],
      llm,
      toolExecutor,
    });

    const systemMessages = result.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toContain('nothing staged');
  });

  it('injects system message after { blocked: true }', async () => {
    const toolCall: ChatToolCall = { id: 'call-3', name: 'memphis_fs_write', arguments: {} };
    const llm = makeLlm([
      { content: '', tool_calls: [toolCall] },
      { content: 'Refused.' },
    ]);
    const toolExecutor = makeExecutor({
      memphis_fs_write: () => JSON.stringify({ blocked: true, tool: 'memphis_fs_write' }),
    });

    const result = await runAgentLoop({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'write file' }],
      llm,
      toolExecutor,
    });

    const systemMessages = result.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toContain('memphis_fs_write');
  });

  it('does NOT inject system message when tool returns success', async () => {
    const toolCall: ChatToolCall = { id: 'call-4', name: 'memphis_journal', arguments: {} };
    const llm = makeLlm([
      { content: '', tool_calls: [toolCall] },
      { content: 'Saved.' },
    ]);
    const toolExecutor = makeExecutor({
      memphis_journal: () => JSON.stringify({ ok: true, index: 42 }),
    });

    const result = await runAgentLoop({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'remember this' }],
      llm,
      toolExecutor,
    });

    const systemMessages = result.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(0);
  });

  it('summarises multiple tool errors in a single system message', async () => {
    const tc1: ChatToolCall = { id: 'c1', name: 'memphis_exec', arguments: {} };
    const tc2: ChatToolCall = { id: 'c2', name: 'memphis_git', arguments: {} };
    const llm = makeLlm([
      { content: '', tool_calls: [tc1, tc2] },
      { content: 'Both failed.' },
    ]);
    const toolExecutor = makeExecutor({
      memphis_exec: () => JSON.stringify({ error: 'PERMISSION_DENIED' }),
      memphis_git: () => JSON.stringify({ ok: false, reason: 'detached HEAD' }),
    });

    const result = await runAgentLoop({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'do stuff' }],
      llm,
      toolExecutor,
    });

    const systemMessages = result.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    const content = systemMessages[0].content;
    expect(content).toContain('memphis_exec');
    expect(content).toContain('memphis_git');
    expect(content).toContain('PERMISSION_DENIED');
    expect(content).toContain('detached HEAD');
  });

  it('system message lands BEFORE the tool messages in the stream', async () => {
    const toolCall: ChatToolCall = { id: 'c1', name: 'memphis_exec', arguments: {} };
    const llm = makeLlm([
      { content: '', tool_calls: [toolCall] },
      { content: 'failed.' },
    ]);
    const toolExecutor = makeExecutor({
      memphis_exec: () => JSON.stringify({ error: 'denied' }),
    });

    const result = await runAgentLoop({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'x' }],
      llm,
      toolExecutor,
    });

    // Find positions in the message stream
    const systemHintIdx = result.messages.findIndex(
      (m) => m.role === 'system' && m.content.includes('Tool execution surfaced errors'),
    );
    const toolMsgIdx = result.messages.findIndex((m) => m.role === 'tool');
    expect(systemHintIdx).toBeGreaterThan(-1);
    expect(toolMsgIdx).toBeGreaterThan(-1);
    expect(systemHintIdx).toBeLessThan(toolMsgIdx);
  });
});
