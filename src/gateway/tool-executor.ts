/**
 * In-process tool executor — calls Memphis MCP tool functions directly,
 * no HTTP, no MCP client. Used when the gateway runs inside Memphis.
 */

import type { ToolExecutor } from './chat-types.js';
import { runMemphisDecide } from '../mcp/tools/decide.js';
import { runMemphisExec } from '../mcp/tools/exec.js';
import { runMemphisHealth } from '../mcp/tools/health.js';
import { runMemphisJournal } from '../mcp/tools/journal.js';
import { runMemphisRecall } from '../mcp/tools/recall.js';
import { runMemphisWebFetch } from '../mcp/tools/web-fetch.js';
import type { ChatToolCall, ChatToolDefinition } from '../providers/index.js';

const TOOL_DEFINITIONS: ChatToolDefinition[] = [
  {
    name: 'memphis_journal',
    description: 'Save an entry to the Memphis journal chain',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to journal' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memphis_recall',
    description: 'Semantic search across Memphis memory chains',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (1-50)', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'memphis_decide',
    description: 'Record a decision with context',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        choice: { type: 'string' },
        context: { type: 'string' },
      },
      required: ['title', 'choice'],
    },
  },
  {
    name: 'memphis_health',
    description: 'Check Memphis runtime health',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memphis_web_fetch',
    description: 'Fetch a public URL',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to fetch' } },
      required: ['url'],
    },
  },
  {
    name: 'memphis_exec',
    description: 'Execute a shell command',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Command to execute' } },
      required: ['command'],
    },
  },
];

async function executeTool(call: ChatToolCall): Promise<string> {
  const args = call.arguments;
  switch (call.name) {
    case 'memphis_journal':
      return JSON.stringify(
        await runMemphisJournal({
          content: args.content as string,
          tags: args.tags as string[] | undefined,
        }),
      );
    case 'memphis_recall':
      return JSON.stringify(
        runMemphisRecall({ query: args.query as string, limit: (args.limit as number) ?? 5 }),
      );
    case 'memphis_decide':
      return JSON.stringify(
        await runMemphisDecide({
          title: args.title as string,
          choice: args.choice as string,
          context: args.context as string | undefined,
        }),
      );
    case 'memphis_health':
      return JSON.stringify(await runMemphisHealth());
    case 'memphis_web_fetch':
      return JSON.stringify(await runMemphisWebFetch({ url: args.url as string }));
    case 'memphis_exec':
      try {
        return JSON.stringify(runMemphisExec({ command: args.command as string }));
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    default:
      return JSON.stringify({ error: `unknown tool: ${call.name}` });
  }
}

export function createInProcessToolExecutor(): ToolExecutor {
  return {
    listTools(): ChatToolDefinition[] {
      return TOOL_DEFINITIONS;
    },
    execute: executeTool,
  };
}
