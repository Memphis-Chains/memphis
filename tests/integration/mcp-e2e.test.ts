/**
 * E2E integration test: Memphis MCP server ↔ MCP client round-trip.
 *
 * Simulates what OpenClaw does: connect to Memphis MCP, discover tools,
 * call each tool, verify responses. Uses InMemoryTransport to avoid
 * port conflicts in CI.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemphisMcpServer } from '../../src/mcp/server.js';
import * as decideTool from '../../src/mcp/tools/decide.js';
import * as healthTool from '../../src/mcp/tools/health.js';
import * as journalTool from '../../src/mcp/tools/journal.js';
import * as recallTool from '../../src/mcp/tools/recall.js';

const ALL_TOOL_NAMES = [
  'memphis_journal',
  'memphis_recall',
  'memphis_decide',
  'memphis_health',
  'memphis_web_fetch',
  'memphis_exec',
  'memphis_loop_step',
];

describe('MCP E2E: full tool-calling round-trip', () => {
  let client: Client;
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  async function connect(): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMemphisMcpServer();
    await server.connect(serverTransport);

    client = new Client({ name: 'openclaw-e2e', version: '0.1.0' });
    await client.connect(clientTransport);

    cleanup = async () => {
      await client.close();
      await server.close();
    };

    return client;
  }

  it('discovers all 7 tools', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it('round-trips memphis_journal', async () => {
    vi.spyOn(journalTool, 'runMemphisJournal').mockResolvedValue({
      success: true,
      index: 42,
      hash: 'abc123',
    });

    const c = await connect();
    const result = await c.callTool({
      name: 'memphis_journal',
      arguments: { content: 'E2E test entry', tags: ['e2e', 'ci'] },
    });

    const structured = (result as { structuredContent?: unknown }).structuredContent;
    expect(structured).toEqual({ success: true, index: 42, hash: 'abc123' });
    expect(journalTool.runMemphisJournal).toHaveBeenCalledWith({
      content: 'E2E test entry',
      tags: ['e2e', 'ci'],
    });
  });

  it('round-trips memphis_recall', async () => {
    vi.spyOn(recallTool, 'runMemphisRecall').mockReturnValue({
      results: [
        { content: 'remembered thought', score: 0.92, tags: ['memory'] },
      ],
    });

    const c = await connect();
    const result = await c.callTool({
      name: 'memphis_recall',
      arguments: { query: 'what do I remember?', limit: 5 },
    });

    const structured = (result as { structuredContent?: unknown }).structuredContent;
    expect(structured).toEqual({
      results: [{ content: 'remembered thought', score: 0.92, tags: ['memory'] }],
    });
  });

  it('round-trips memphis_decide', async () => {
    vi.spyOn(decideTool, 'runMemphisDecide').mockResolvedValue({
      success: true,
      index: 7,
    });

    const c = await connect();
    const result = await c.callTool({
      name: 'memphis_decide',
      arguments: { title: 'Ship or wait?', choice: 'ship', context: 'CI green' },
    });

    const structured = (result as { structuredContent?: unknown }).structuredContent;
    expect(structured).toEqual({ success: true, index: 7 });
  });

  it('round-trips memphis_health', async () => {
    vi.spyOn(healthTool, 'runMemphisHealth').mockResolvedValue({
      status: 'ok',
      version: '5.1.2',
      uptime: 1234,
      database: { ok: true },
      rustBridge: { ok: true },
      dataDir: { ok: true, path: '/tmp/test' },
      embeddingProvider: { ok: true, provider: 'ollama' },
    } as ReturnType<typeof healthTool.runMemphisHealth> extends Promise<infer R> ? R : never);

    const c = await connect();
    const result = await c.callTool({
      name: 'memphis_health',
      arguments: {},
    });

    const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(structured).toBeDefined();
    expect(structured?.status).toBe('ok');
  });

  it('round-trips memphis_exec (echo)', async () => {
    const c = await connect();
    const result = await c.callTool({
      name: 'memphis_exec',
      arguments: { command: 'echo e2e_test_ok' },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout.trim()).toBe('e2e_test_ok');
  });

  it('round-trips memphis_exec — blocks dangerous command', async () => {
    const c = await connect();
    const result = await c.callTool({
      name: 'memphis_exec',
      arguments: { command: 'rm -rf /' },
    });

    // MCP tools return errors as isError in content, not as thrown exceptions
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('not in gateway allowlist');
  });

  it('round-trips memphis_loop_step — tool_call action', async () => {
    const c = await connect();
    const result = await c.callTool({
      name: 'memphis_loop_step',
      arguments: {
        state: {
          steps: 0,
          tool_calls: 0,
          wait_ms: 0,
          errors: 0,
          completed: false,
          halt_reason: null,
        },
        action: { type: 'tool_call', data: { tool: 'memphis_journal' } },
      },
    });

    const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(structured).toBeDefined();
    expect(structured?.applied).toBe(true);
    const state = structured?.state as Record<string, unknown>;
    expect(state?.steps).toBe(1);
    expect(state?.tool_calls).toBe(1);
  });

  it('round-trips memphis_loop_step — enforces limits', async () => {
    const c = await connect();
    const result = await c.callTool({
      name: 'memphis_loop_step',
      arguments: {
        state: {
          steps: 32,
          tool_calls: 10,
          wait_ms: 0,
          errors: 0,
          completed: false,
          halt_reason: null,
        },
        action: { type: 'tool_call', data: { tool: 'test' } },
        limits: {
          max_steps: 32,
          max_tool_calls: 16,
          max_wait_ms: 120_000,
          max_errors: 4,
        },
      },
    });

    const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(structured?.applied).toBe(false);
    expect(structured?.reason).toContain('max_steps');
  });

  it('full agent loop simulation: discover → call → enforce → complete', async () => {
    // Mock journal + recall so they don't touch disk
    vi.spyOn(journalTool, 'runMemphisJournal').mockResolvedValue({
      success: true,
      index: 1,
      hash: 'sim',
    });
    vi.spyOn(recallTool, 'runMemphisRecall').mockReturnValue({
      results: [],
    });

    const c = await connect();

    // Step 1: Discover tools (like OpenClaw does on startup)
    const { tools } = await c.listTools();
    expect(tools.length).toBe(7);

    // Step 2: Filter out internal tools (like OpenClaw does)
    const userTools = tools.filter((t) => t.name !== 'memphis_loop_step');
    expect(userTools.length).toBe(6);

    // Step 3: Enforce loop step before tool call
    const step1 = await c.callTool({
      name: 'memphis_loop_step',
      arguments: {
        state: { steps: 0, tool_calls: 0, wait_ms: 0, errors: 0, completed: false, halt_reason: null },
        action: { type: 'tool_call', data: { tool: 'memphis_journal' } },
      },
    });
    const step1Result = (step1 as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(step1Result?.applied).toBe(true);

    // Step 4: Execute the tool call
    const journal = await c.callTool({
      name: 'memphis_journal',
      arguments: { content: 'simulation entry' },
    });
    expect((journal as { structuredContent?: Record<string, unknown> }).structuredContent).toEqual({
      success: true,
      index: 1,
      hash: 'sim',
    });

    // Step 5: Enforce loop step for completion
    const step2 = await c.callTool({
      name: 'memphis_loop_step',
      arguments: {
        state: (step1Result?.state ?? {}) as Record<string, unknown>,
        action: { type: 'complete', data: { summary: 'done' } },
      },
    });
    const step2Result = (step2 as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(step2Result?.applied).toBe(true);
    const finalState = step2Result?.state as Record<string, unknown>;
    expect(finalState?.completed).toBe(true);
    expect(finalState?.steps).toBe(2);
  });
});
