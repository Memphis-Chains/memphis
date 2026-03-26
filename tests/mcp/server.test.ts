import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { createMemphisMcpServer } from '../../src/mcp/server.js';
import * as decideTool from '../../src/mcp/tools/decide.js';
import * as journalTool from '../../src/mcp/tools/journal.js';
import * as recallTool from '../../src/mcp/tools/recall.js';
import * as searchTool from '../../src/mcp/tools/search.js';

describe('memphis mcp server', () => {
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
});
