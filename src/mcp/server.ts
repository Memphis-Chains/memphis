import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { runMemphisCaseAppend, runMemphisCaseQuery } from './tools/case-entry.js';
import { runMemphisCodeRead } from './tools/code-read.js';
import { runMemphisDecide } from './tools/decide.js';
import { runMemphisExec } from './tools/exec.js';
import { runMemphisHealth } from './tools/health.js';
import { runMemphisJournal } from './tools/journal.js';
import { runMemphisLoopStep } from './tools/loop-step.js';
import { runMemphisRecall } from './tools/recall.js';
import { runMemphisSearch } from './tools/search.js';
import { runMemphisSelfModify } from './tools/self-modify.js';
import { runMemphisSoulRead, runMemphisSoulWrite } from './tools/soul.js';
import { runMemphisWebFetch } from './tools/web-fetch.js';
import { RollbackManager } from '../backup/rollback.js';
import { resolveToolPolicy } from '../gateway/authorization.js';
import { loadConfig } from '../infra/config/env.js';
import { CaseChainAdapter } from '../infra/storage/case-chain-adapter.js';
import { createSqliteClient, runMigrations } from '../infra/storage/sqlite/client.js';
import { SqliteEvolveSessionRepository } from '../infra/storage/sqlite/repositories/evolve-session-repository.js';
import { SqliteToolCallApprovalRepository } from '../infra/storage/sqlite/repositories/tool-call-approval-repository.js';
import {
  SqliteToolPermissionRepository,
  type ToolPolicy,
} from '../infra/storage/sqlite/repositories/tool-permission-repository.js';
import { ensureSoulManifest } from '../soul/manifest.js';
import type { SoulManifest } from '../soul/types.js';

interface RepoBundle {
  permissions: SqliteToolPermissionRepository;
  approvals: SqliteToolCallApprovalRepository;
}

interface EvolveBundle {
  sessionRepo: SqliteEvolveSessionRepository;
  rollback: RollbackManager;
  caseAdapter: CaseChainAdapter;
}

function getEvolveDeps(): EvolveBundle {
  const config = loadConfig();
  const db = createSqliteClient(config.DATABASE_URL);
  runMigrations(db);
  const dataDir = process.env.MEMPHIS_DATA_DIR ?? './data';
  return {
    sessionRepo: new SqliteEvolveSessionRepository(db),
    rollback: new RollbackManager(dataDir),
    caseAdapter: new CaseChainAdapter(process.env),
  };
}

function getRepos(): RepoBundle {
  const config = loadConfig();
  const db = createSqliteClient(config.DATABASE_URL);
  runMigrations(db);
  return {
    permissions: new SqliteToolPermissionRepository(db),
    approvals: new SqliteToolCallApprovalRepository(db),
  };
}

/**
 * Returns 'allow', 'deny', or 'require-approval' for a tool.
 *
 * Resolution order: explicit SQLite policy > trust rule > mode+tier default.
 */
function getToolPolicy(
  repo: SqliteToolPermissionRepository,
  toolName: string,
  manifest: SoulManifest,
): ToolPolicy {
  return resolveToolPolicy({ toolName, permissionRepo: repo, manifest }).policy;
}

/** Should this tool be registered at all? */
function shouldRegister(policy: ToolPolicy): boolean {
  return policy !== 'deny';
}

/**
 * Wrap a tool handler to enforce require-approval gating.
 *
 * If the tool's policy is 'require-approval':
 * - If the caller provides an `approval_request_id` that has been approved, execute normally
 * - Otherwise, create a pending approval request and return a pending response
 *
 * If the tool's policy is 'allow', execute normally.
 */
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function pendingResult(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function withApprovalGate<T extends Record<string, unknown>>(
  toolName: string,
  policy: ToolPolicy,
  approvals: SqliteToolCallApprovalRepository,
  handler: (args: T) => Promise<ToolResult>,
): (args: T) => Promise<ToolResult> {
  if (policy === 'allow') return handler;

  return async (args: T) => {
    const approvalRequestId = (args as Record<string, unknown>).approval_request_id as
      | string
      | undefined;

    // If caller provides an approval_request_id, check if it's approved
    if (approvalRequestId) {
      const approved = approvals.findApproved(approvalRequestId);
      if (approved && approved.toolName === toolName) {
        approvals.markUsed(approvalRequestId);
        return handler(args);
      }

      // Check if it exists but isn't approved yet
      const existing = approvals.get(approvalRequestId);
      if (existing) {
        return pendingResult({
          approved: false,
          requestId: existing.requestId,
          state: existing.state,
          message: `tool call ${existing.state === 'pending' ? 'still awaiting' : existing.state}: operator must approve via CLI`,
        });
      }
    }

    // Create a pending approval request
    const request = approvals.createRequest({
      toolName,
      arguments: args as Record<string, unknown>,
    });

    return pendingResult({
      approved: false,
      requestId: request.requestId,
      state: 'pending',
      message: `tool '${toolName}' requires operator approval. Request ID: ${request.requestId}. Operator: run 'memphis config tools approve-call ${request.requestId}'`,
    });
  };
}

export function createMemphisMcpServer(manifest?: SoulManifest): McpServer {
  const server = new McpServer({
    name: 'memphis-mcp',
    version: '0.3.4',
  });

  const { permissions, approvals } = getRepos();
  const evolveDeps = getEvolveDeps();
  const resolvedManifest = manifest ?? ensureSoulManifest();

  const journalPolicy = getToolPolicy(permissions, 'memphis_journal', resolvedManifest);
  if (shouldRegister(journalPolicy)) {
    server.registerTool(
      'memphis_journal',
      {
        description: 'Save entries to journal chain',
        inputSchema: {
          content: z.string().min(1),
          tags: z.array(z.string()).optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_journal', journalPolicy, approvals, async ({ content, tags }) => {
        const result = await runMemphisJournal({ content, tags });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
    );
  }

  const recallPolicy = getToolPolicy(permissions, 'memphis_recall', resolvedManifest);
  if (shouldRegister(recallPolicy)) {
    server.registerTool(
      'memphis_recall',
      {
        description: 'Semantic search across chains',
        inputSchema: {
          query: z.string().min(1),
          limit: z.number().int().min(1).max(50).optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_recall', recallPolicy, approvals, async ({ query, limit }) => {
        const result = runMemphisRecall({ query, limit });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
    );
  }

  const searchPolicy = getToolPolicy(permissions, 'memphis_search', resolvedManifest);
  if (shouldRegister(searchPolicy)) {
    server.registerTool(
      'memphis_search',
      {
        description: 'Exact phrase search across indexed memory content',
        inputSchema: {
          query: z.string().min(1),
          limit: z.number().int().min(1).max(50).optional(),
          chain: z.string().min(1).optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_search',
        searchPolicy,
        approvals,
        async ({ query, limit, chain }) => {
          const result = runMemphisSearch({ query, limit, chain });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
          };
        },
      ),
    );
  }

  const decidePolicy = getToolPolicy(permissions, 'memphis_decide', resolvedManifest);
  if (shouldRegister(decidePolicy)) {
    server.registerTool(
      'memphis_decide',
      {
        description: 'Record decisions',
        inputSchema: {
          title: z.string().min(1),
          choice: z.string().min(1),
          context: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_decide',
        decidePolicy,
        approvals,
        async ({ title, choice, context }) => {
          const result = await runMemphisDecide({ title, choice, context });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
          };
        },
      ),
    );
  }

  const healthPolicy = getToolPolicy(permissions, 'memphis_health', resolvedManifest);
  if (shouldRegister(healthPolicy)) {
    server.registerTool(
      'memphis_health',
      {
        description:
          'Check Memphis runtime health (database, rust bridge, data dir, embedding provider)',
        inputSchema: {
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_health', healthPolicy, approvals, async () => {
        const result = await runMemphisHealth();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
    );
  }

  const webFetchPolicy = getToolPolicy(permissions, 'memphis_web_fetch', resolvedManifest);
  if (shouldRegister(webFetchPolicy)) {
    server.registerTool(
      'memphis_web_fetch',
      {
        description:
          'Fetch a public URL and return its content (blocks internal/private addresses)',
        inputSchema: {
          url: z.string().url(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_web_fetch', webFetchPolicy, approvals, async ({ url }) => {
        const result = await runMemphisWebFetch({ url });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
    );
  }

  const codeReadPolicy = getToolPolicy(permissions, 'memphis_code_read', resolvedManifest);
  if (shouldRegister(codeReadPolicy)) {
    server.registerTool(
      'memphis_code_read',
      {
        description: 'Read files inside ~/memphis/ (whitelisted, read-only, no path traversal)',
        inputSchema: {
          path: z.string().min(1),
          startLine: z.number().int().min(1).optional(),
          endLine: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(2000).optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_code_read', codeReadPolicy, approvals, async ({ path, startLine, endLine, limit }) => {
        const result = runMemphisCodeRead({ path, startLine, endLine, limit });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
    );
  }

  const loopStepPolicy = getToolPolicy(permissions, 'memphis_loop_step', resolvedManifest);
  if (shouldRegister(loopStepPolicy)) {
    server.registerTool(
      'memphis_loop_step',
      {
        description:
          'Enforce agent loop limits via Rust LoopEngine (authoritative step enforcement)',
        inputSchema: {
          state: z.object({
            steps: z.number().int().min(0),
            tool_calls: z.number().int().min(0),
            wait_ms: z.number().int().min(0),
            errors: z.number().int().min(0),
            completed: z.boolean(),
            halt_reason: z.string().nullable(),
          }),
          action: z.discriminatedUnion('type', [
            z.object({ type: z.literal('tool_call'), data: z.object({ tool: z.string() }) }),
            z.object({ type: z.literal('wait'), data: z.object({ duration_ms: z.number() }) }),
            z.object({ type: z.literal('complete'), data: z.object({ summary: z.string() }) }),
            z.object({
              type: z.literal('error'),
              data: z.object({ recoverable: z.boolean(), message: z.string() }),
            }),
          ]),
          limits: z
            .object({
              max_steps: z.number().int().min(1),
              max_tool_calls: z.number().int().min(1),
              max_wait_ms: z.number().int().min(1),
              max_errors: z.number().int().min(1),
            })
            .optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_loop_step',
        loopStepPolicy,
        approvals,
        async ({ state, action, limits }) => {
          const result = runMemphisLoopStep({ state, action, limits });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        },
      ),
    );
  }

  const execPolicy = getToolPolicy(permissions, 'memphis_exec', resolvedManifest);
  if (shouldRegister(execPolicy)) {
    server.registerTool(
      'memphis_exec',
      {
        description: 'Execute a shell command',
        inputSchema: {
          command: z.string().min(1).max(256),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_exec', execPolicy, approvals, async ({ command }) => {
        try {
          const result = runMemphisExec({ command });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
            isError: true,
          };
        }
      }),
    );
  }

  const caseAppendPolicy = getToolPolicy(permissions, 'memphis_case_append', resolvedManifest);
  if (shouldRegister(caseAppendPolicy)) {
    server.registerTool(
      'memphis_case_append',
      {
        description:
          'Append a case entry to the cognitive knowledge graph (8 Polish grammatical cases)',
        inputSchema: {
          entry: z.discriminatedUnion('case_type', [
            z.object({
              case_type: z.literal('nominative'),
              entity: z.string().min(1),
              action: z.string().min(1),
              timestamp: z.string().min(1),
            }),
            z.object({
              case_type: z.literal('genitive'),
              owner: z.string().min(1),
              possessed: z.string().min(1),
            }),
            z.object({
              case_type: z.literal('dative'),
              giver: z.string().min(1),
              recipient: z.string().min(1),
              object: z.string().min(1),
            }),
            z.object({
              case_type: z.literal('accusative'),
              subject: z.string().min(1),
              verb: z.string().min(1),
              object: z.string().min(1),
            }),
            z.object({
              case_type: z.literal('instrumental'),
              actor: z.string().min(1),
              instrument: z.string().min(1),
              target: z.string().min(1),
            }),
            z.object({
              case_type: z.literal('locative'),
              entity: z.string().min(1),
              location: z.string().min(1),
            }),
            z.object({
              case_type: z.literal('ablative'),
              entity: z.string().min(1),
              origin: z.string().min(1),
              destination: z.string().optional(),
            }),
            z.object({
              case_type: z.literal('vocative'),
              invoker: z.string().min(1),
              invocation: z.string().min(1),
              target: z.string().min(1),
            }),
          ]),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_case_append', caseAppendPolicy, approvals, async ({ entry }) => {
        const result = await runMemphisCaseAppend({ entry });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    );
  }

  const caseQueryPolicy = getToolPolicy(permissions, 'memphis_case_query', resolvedManifest);
  if (shouldRegister(caseQueryPolicy)) {
    server.registerTool(
      'memphis_case_query',
      {
        description:
          'Query the cognitive knowledge graph by case type, entity, actor, target, instrument, or location',
        inputSchema: {
          query: z.object({
            case_type: z
              .enum([
                'nominative',
                'genitive',
                'dative',
                'accusative',
                'instrumental',
                'locative',
                'ablative',
                'vocative',
              ])
              .optional(),
            entity: z.string().optional(),
            actor: z.string().optional(),
            target: z.string().optional(),
            instrument: z.string().optional(),
            location: z.string().optional(),
            limit: z.number().int().min(1).max(100).optional(),
          }),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_case_query', caseQueryPolicy, approvals, async ({ query }) => {
        const result = await runMemphisCaseQuery({ query });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    );
  }

  const soulReadPolicy = getToolPolicy(permissions, 'memphis_soul_read', resolvedManifest);
  if (shouldRegister(soulReadPolicy)) {
    server.registerTool(
      'memphis_soul_read',
      {
        description: 'Read soul memory (persistent identity, user preferences, self-knowledge)',
        inputSchema: {
          section: z.enum(['user', 'self', 'context', 'all']).optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_soul_read', soulReadPolicy, approvals, async ({ section }) => {
        const result = await runMemphisSoulRead({ section });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    );
  }

  const soulWritePolicy = getToolPolicy(permissions, 'memphis_soul_write', resolvedManifest);
  if (shouldRegister(soulWritePolicy)) {
    server.registerTool(
      'memphis_soul_write',
      {
        description: 'Update soul memory (user preferences, self-learnings, context)',
        inputSchema: {
          updates: z.object({
            user: z
              .object({
                name: z.string().optional(),
                languages: z.array(z.string()).optional(),
                preferences: z.array(z.string()).optional(),
                expertise: z.array(z.string()).optional(),
                integrations: z.array(z.string()).optional(),
              })
              .optional(),
            self: z
              .object({
                personality: z.string().optional(),
                strengths: z.array(z.string()).optional(),
                learnings: z.array(z.string()).optional(),
                evolvedCapabilities: z.array(z.string()).optional(),
              })
              .optional(),
            context: z
              .object({
                activeWork: z.string().optional(),
                recentDecisions: z.array(z.string()).optional(),
              })
              .optional(),
          }),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_soul_write', soulWritePolicy, approvals, async ({ updates }) => {
        const result = await runMemphisSoulWrite({ updates });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    );
  }

  const selfModifyPolicy = getToolPolicy(permissions, 'memphis_self_modify', resolvedManifest);
  if (shouldRegister(selfModifyPolicy)) {
    server.registerTool(
      'memphis_self_modify',
      {
        description: 'Safe self-modification with snapshot, branch isolation, and test gate',
        inputSchema: {
          intent: z.string().min(1),
          files: z.array(z.string()).min(1),
          changes: z.record(z.string(), z.string()),
          passphrase: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_self_modify',
        selfModifyPolicy,
        approvals,
        async ({ intent, files, changes, passphrase }) => {
          const result = await runMemphisSelfModify(
            { intent, files, changes, passphrase },
            { ...evolveDeps },
          );
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        },
      ),
    );
  }

  return server;
}
