import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { TOOL_REGISTRY } from '../../src/gateway/tool-registry.js';
import { createMemphisMcpServer } from '../../src/mcp/server.js';
import * as decideTool from '../../src/mcp/tools/decide.js';
import * as journalTool from '../../src/mcp/tools/journal.js';
import * as recallTool from '../../src/mcp/tools/recall.js';
import * as searchTool from '../../src/mcp/tools/search.js';

describe('memphis mcp server', () => {
  it('derives selected MCP input schemas from TOOL_REGISTRY', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMemphisMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: 'schema-test-client', version: '1.0.0' });
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

    for (const toolName of [
      'memphis_health',
      'memphis_self_describe',
      'memphis_slo_status',
      'memphis_presence',
      'memphis_repair',
      'memphis_self_modify',
      'memphis_recall',
      'memphis_search',
      'memphis_code_read',
      'memphis_brave_search',
    ]) {
      const registrySchema = z.toJSONSchema(TOOL_REGISTRY[toolName]!.inputSchema!);
      const registryProperties = Object.keys(
        (registrySchema as { properties?: Record<string, unknown> }).properties ?? {},
      ).sort();
      const mcpProperties = Object.keys(
        (byName.get(toolName)?.inputSchema as { properties?: Record<string, unknown> } | undefined)
          ?.properties ?? {},
      ).sort();
      expect(mcpProperties).toEqual(registryProperties);
    }

    await client.close();
    await server.close();
  });

  it('registers and executes core memory MCP tools', async () => {
    vi.spyOn(journalTool, 'runMemphisJournal').mockResolvedValue({
      success: true,
      index: 1,
      hash: 'j',
    });
    vi.spyOn(recallTool, 'runMemphisRecall').mockReturnValue({
      results: [{ content: 'r', score: 0.8, tags: ['t'] }],
    });
    vi.spyOn(searchTool, 'runMemphisSearch').mockReturnValue({
      results: [
        {
          sourceKey: 'journal:1',
          chain: 'journal',
          blockIndex: 1,
          blockHash: 'h1',
          blockType: 'journal',
          content: 'exact hit',
          summary: 'exact hit',
          snippet: '[exact] hit',
          tags: ['t'],
          metadata: {},
          score: 0.91,
          indexedAt: new Date().toISOString(),
        },
      ],
    });
    vi.spyOn(decideTool, 'runMemphisDecide').mockResolvedValue({ success: true, index: 2 });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMemphisMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'memphis_journal',
        'memphis_recall',
        'memphis_search',
        'memphis_decide',
      ]),
    );

    const journal = await client.callTool({
      name: 'memphis_journal',
      arguments: { content: 'x', tags: ['a'] },
    });
    expect((journal as { structuredContent?: unknown }).structuredContent).toEqual({
      success: true,
      index: 1,
      hash: 'j',
    });

    const recall = await client.callTool({
      name: 'memphis_recall',
      arguments: { query: 'x', limit: 2 },
    });
    expect((recall as { structuredContent?: unknown }).structuredContent).toEqual({
      results: [{ content: 'r', score: 0.8, tags: ['t'] }],
    });

    const search = await client.callTool({
      name: 'memphis_search',
      arguments: { query: 'exact hit', limit: 2, chain: 'journal' },
    });
    expect((search as { structuredContent?: unknown }).structuredContent).toEqual({
      results: [
        expect.objectContaining({
          sourceKey: 'journal:1',
          chain: 'journal',
          snippet: '[exact] hit',
        }),
      ],
    });

    const decide = await client.callTool({
      name: 'memphis_decide',
      arguments: { title: 'A', choice: 'B' },
    });
    expect((decide as { structuredContent?: unknown }).structuredContent).toEqual({
      success: true,
      index: 2,
    });

    await client.close();
    await server.close();
  });

  it('registers preview tools only when experimental-tools is enabled', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memphis-mcp-flags-'));
    const sharedEnv = {
      MEMPHIS_DATA_DIR: tempDir,
      DATABASE_URL: `file:${join(tempDir, 'feature-flags.db')}`,
      RUST_CHAIN_ENABLED: 'false',
    };

    const [stableClientTransport, stableServerTransport] = InMemoryTransport.createLinkedPair();
    const stableServer = createMemphisMcpServer(undefined, sharedEnv);
    await stableServer.connect(stableServerTransport);
    const stableClient = new Client({ name: 'stable-client', version: '1.0.0' });
    await stableClient.connect(stableClientTransport);
    const stableTools = await stableClient.listTools();
    const stableNames = stableTools.tools.map((tool) => tool.name);
    expect(stableNames).toContain('memphis_chain_verify');
    expect(stableNames).not.toContain('memphis_chain_query');
    expect(stableNames).not.toContain('memphis_providers');
    expect(stableNames).not.toContain('memphis_system_info');
    await stableClient.close();
    await stableServer.close();

    const [previewClientTransport, previewServerTransport] = InMemoryTransport.createLinkedPair();
    const previewServer = createMemphisMcpServer(undefined, {
      ...sharedEnv,
      MEMPHIS_FEATURES: 'experimental-tools',
    });
    await previewServer.connect(previewServerTransport);
    const previewClient = new Client({ name: 'preview-client', version: '1.0.0' });
    await previewClient.connect(previewClientTransport);
    const previewTools = await previewClient.listTools();
    const previewNames = previewTools.tools.map((tool) => tool.name);
    expect(previewNames).toContain('memphis_chain_query');
    expect(previewNames).toContain('memphis_providers');
    expect(previewNames).toContain('memphis_system_info');
    await previewClient.close();
    await previewServer.close();
  });
});
