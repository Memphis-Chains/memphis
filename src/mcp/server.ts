import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runMemphisJournal } from './tools/journal.js';
import { runMemphisRecall } from './tools/recall.js';
import { runMemphisDecide } from './tools/decide.js';

export function createMemphisMcpServer(): McpServer {
  const server = new McpServer({
    name: 'memphis-v5-mcp',
    version: '5.1.2',
  });

  server.registerTool(
    'memphis_journal',
    {
      description: 'Save entries to journal chain',
      inputSchema: {
        content: z.string().min(1),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ content, tags }) => {
      const result = await runMemphisJournal({ content, tags });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    'memphis_recall',
    {
      description: 'Semantic search across chains',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, limit }) => {
      const result = runMemphisRecall({ query, limit });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    'memphis_decide',
    {
      description: 'Record decisions',
      inputSchema: {
        title: z.string().min(1),
        choice: z.string().min(1),
        context: z.string().optional(),
      },
    },
    async ({ title, choice, context }) => {
      const result = await runMemphisDecide({ title, choice, context });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  return server;
}
