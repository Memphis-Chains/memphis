/**
 * In-process tool executor — calls Memphis MCP tool functions directly,
 * no HTTP, no MCP client. Used when the gateway runs inside Memphis.
 */

import { recordAuthorizationDecision, resolveToolPolicy } from './authorization.js';
import type { ToolExecutor } from './chat-types.js';
import { RollbackManager } from '../backup/rollback.js';
import { getDataDir } from '../config/paths.js';
import { AppError } from '../core/errors.js';
import { CaseChainAdapter } from '../infra/storage/case-chain-adapter.js';
import type { SqliteEvolveSessionRepository } from '../infra/storage/sqlite/repositories/evolve-session-repository.js';
import { runMemphisCaseAppend, runMemphisCaseQuery } from '../mcp/tools/case-entry.js';
import { runMemphisDecide } from '../mcp/tools/decide.js';
import { runMemphisExec } from '../mcp/tools/exec.js';
import { runMemphisHealth } from '../mcp/tools/health.js';
import { runMemphisJournal } from '../mcp/tools/journal.js';
import { runMemphisRecall } from '../mcp/tools/recall.js';
import { runMemphisSearch } from '../mcp/tools/search.js';
import { runMemphisSelfModify } from '../mcp/tools/self-modify.js';
import { runMemphisSoulRead, runMemphisSoulWrite } from '../mcp/tools/soul.js';
import { runMemphisWebFetch } from '../mcp/tools/web-fetch.js';
import type { ChatToolCall, ChatToolDefinition } from '../providers/index.js';
import { loadSoulManifest } from '../soul/manifest.js';
import { updateSoulMemory } from '../soul/memory.js';

export type InProcessToolExecutorDeps = {
  evolveSessionRepository?: SqliteEvolveSessionRepository;
  caseAdapter?: CaseChainAdapter;
  rollback?: RollbackManager;
  projectRoot?: string;
};

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
    name: 'memphis_search',
    description: 'Exact phrase search across indexed Memphis memory',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Exact phrase to search for' },
        limit: { type: 'number', description: 'Max results (1-50)', default: 5 },
        chain: { type: 'string', description: 'Optional chain filter' },
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
    name: 'memphis_soul_read',
    description: 'Read soul memory and persistent identity',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['user', 'self', 'context', 'all'] },
      },
    },
  },
  {
    name: 'memphis_soul_write',
    description: 'Update soul memory and persistent preferences',
    inputSchema: {
      type: 'object',
      properties: {
        updates: { type: 'object', description: 'Soul memory update payload' },
      },
      required: ['updates'],
    },
  },
  {
    name: 'memphis_case_append',
    description: 'Append an entry to the case chain',
    inputSchema: {
      type: 'object',
      properties: {
        entry: { type: 'object', description: 'Case chain entry payload' },
      },
      required: ['entry'],
    },
  },
  {
    name: 'memphis_case_query',
    description: 'Query the case chain index',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'object', description: 'Case chain query payload' },
      },
      required: ['query'],
    },
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
  {
    name: 'memphis_self_modify',
    description: 'Safe self-modification with snapshot, branch isolation, and test gate',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        changes: { type: 'object', additionalProperties: { type: 'string' } },
        passphrase: { type: 'string' },
      },
      required: ['intent', 'files', 'changes'],
    },
  },
];

async function executeTool(call: ChatToolCall, deps: InProcessToolExecutorDeps): Promise<string> {
  // Enforce tiered authorization before execution
  const manifest = loadSoulManifest();
  if (manifest) {
    const result = resolveToolPolicy({ toolName: call.name, manifest });
    if (result.policy === 'deny') {
      if (deps.caseAdapter) {
        await recordAuthorizationDecision(call.name, 'denied', result.reason, deps.caseAdapter);
      }
      throw new AppError(
        'PERMISSION_DENIED',
        `Tool ${call.name} is denied by policy: ${result.reason}`,
        403,
      );
    }
    if (result.policy === 'require-approval') {
      if (deps.caseAdapter) {
        await recordAuthorizationDecision(call.name, 'denied', result.reason, deps.caseAdapter);
      }
      throw new AppError(
        'PERMISSION_DENIED',
        `Tool ${call.name} requires approval: ${result.reason}`,
        403,
      );
    }
    if (deps.caseAdapter) {
      await recordAuthorizationDecision(call.name, 'auto-approved', result.reason, deps.caseAdapter);
    }
  }

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
    case 'memphis_search':
      return JSON.stringify(
        runMemphisSearch({
          query: args.query as string,
          limit: (args.limit as number) ?? 5,
          chain: args.chain as string | undefined,
        }),
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
    case 'memphis_soul_read':
      return JSON.stringify(
        await runMemphisSoulRead({
          section: args.section as 'user' | 'self' | 'context' | 'all' | undefined,
        }),
      );
    case 'memphis_soul_write':
      return JSON.stringify(
        await runMemphisSoulWrite(
          {
            updates: (args.updates as Record<string, unknown>) ?? {},
          },
          deps.caseAdapter
            ? {
                update: updateSoulMemory,
                caseAdapter: deps.caseAdapter,
              }
            : undefined,
        ),
      );
    case 'memphis_case_append':
      return JSON.stringify(
        await runMemphisCaseAppend(
          { entry: args.entry as Record<string, unknown> as never },
          deps.caseAdapter ? { adapter: deps.caseAdapter } : undefined,
        ),
      );
    case 'memphis_case_query':
      return JSON.stringify(
        await runMemphisCaseQuery(
          { query: args.query as Record<string, unknown> as never },
          deps.caseAdapter ? { adapter: deps.caseAdapter } : undefined,
        ),
      );
    case 'memphis_web_fetch':
      return JSON.stringify(await runMemphisWebFetch({ url: args.url as string }));
    case 'memphis_exec':
      try {
        return JSON.stringify(runMemphisExec({ command: args.command as string }));
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    case 'memphis_self_modify': {
      if (!deps.evolveSessionRepository) {
        return JSON.stringify({
          error: 'memphis_self_modify requires evolve session repository in this runtime surface',
        });
      }
      const result = await runMemphisSelfModify(
        {
          intent: args.intent as string,
          files: (args.files as string[]) ?? [],
          changes: (args.changes as Record<string, string>) ?? {},
          passphrase: args.passphrase as string | undefined,
        },
        {
          sessionRepo: deps.evolveSessionRepository,
          rollback: deps.rollback ?? new RollbackManager(getDataDir()),
          caseAdapter: deps.caseAdapter ?? new CaseChainAdapter(),
          projectRoot: deps.projectRoot,
        },
      );
      return JSON.stringify(result);
    }
    default:
      return JSON.stringify({ error: `unknown tool: ${call.name}` });
  }
}

export function createInProcessToolExecutor(deps: InProcessToolExecutorDeps = {}): ToolExecutor {
  return {
    listTools(): ChatToolDefinition[] {
      return TOOL_DEFINITIONS;
    },
    execute(call: ChatToolCall): Promise<string> {
      return executeTool(call, deps);
    },
  };
}
