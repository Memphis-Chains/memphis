import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { runMemphisBuild } from './tools/build.js';
import { runMemphisCaseAppend, runMemphisCaseQuery } from './tools/case-entry.js';
import { runMemphisChainQuery } from './tools/chain-query.js';
import { runMemphisCodeRead } from './tools/code-read.js';
import {
  runMemphisConfigReload,
  runMemphisConfigShow,
} from './tools/config.js';
import { runMemphisDb } from './tools/db.js';
import { runMemphisDecide } from './tools/decide.js';
import { runMemphisDeploy } from './tools/deploy.js';
import { runMemphisExec } from './tools/exec.js';
import { runMemphisFsOps } from './tools/fs-ops.js';
import { runMemphisFsWrite } from './tools/fs-write.js';
import { runMemphisGit } from './tools/git.js';
import { runMemphisGlob } from './tools/glob.js';
import { runMemphisGrep } from './tools/grep.js';
import { runMemphisHealthCheck } from './tools/health-check.js';
import { runMemphisHealth } from './tools/health.js';
import { runMemphisJournal } from './tools/journal.js';
import { runMemphisLoopStep } from './tools/loop-step.js';
import { runMemphisPackage } from './tools/package.js';
import { runMemphisPresence } from './tools/presence.js';
import { runMemphisProviders } from './tools/providers.js';
import { runMemphisRecall } from './tools/recall.js';
import { runMemphisRestart } from './tools/restart.js';
import { runMemphisSearch } from './tools/search.js';
import { runMemphisSelfModify } from './tools/self-modify.js';
import { runMemphisSoulRead, runMemphisSoulWrite } from './tools/soul.js';
import { runMemphisSystemInfo } from './tools/system-info.js';
import { runMemphisTest } from './tools/test-run.js';
import { runMemphisWebFetch } from './tools/web-fetch.js';
import { runMemphisWebSearch } from './tools/web-search.js';
import { RollbackManager } from '../backup/rollback.js';
import { resolveToolPolicy } from '../gateway/authorization.js';
import { isToolEnabledByFeatureFlag } from '../gateway/tool-registry.js';
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

function getEvolveDeps(rawEnv: NodeJS.ProcessEnv = process.env): EvolveBundle {
  const config = loadConfig(rawEnv);
  const db = createSqliteClient(config.DATABASE_URL);
  runMigrations(db);
  const dataDir = rawEnv.MEMPHIS_DATA_DIR ?? './data';
  return {
    sessionRepo: new SqliteEvolveSessionRepository(db),
    rollback: new RollbackManager(dataDir),
    caseAdapter: new CaseChainAdapter(rawEnv),
  };
}

function getRepos(rawEnv: NodeJS.ProcessEnv = process.env): RepoBundle {
  const config = loadConfig(rawEnv);
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

function shouldRegisterTool(
  toolName: string,
  policy: ToolPolicy,
  rawEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return shouldRegister(policy) && isToolEnabledByFeatureFlag(toolName, rawEnv);
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

/**
 * Strip redacted fields from args before they're persisted to the approval
 * SQLite table. The original `args` passed to the handler are NOT modified
 * — the handler still receives the real values at execution time. Only
 * the persisted / later-echoed copy loses the secret.
 *
 * Codex P1 (Round 4): memphis_restart accepts `passphrase` in its input;
 * without redaction, that operator secret ended up in SQLite and in the
 * output of `memphis config tools pending` and sibling listing commands.
 */
function redactForStorage(
  args: Record<string, unknown>,
  redactFields: readonly string[],
): Record<string, unknown> {
  if (redactFields.length === 0) return args;
  const copy = { ...args };
  for (const key of redactFields) {
    if (key in copy) copy[key] = '[REDACTED]';
  }
  return copy;
}

function withApprovalGate<T extends Record<string, unknown>>(
  toolName: string,
  policy: ToolPolicy,
  approvals: SqliteToolCallApprovalRepository,
  handler: (args: T) => Promise<ToolResult>,
  redactFields: readonly string[] = [],
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

    // Create a pending approval request — redact sensitive fields so the
    // persisted arguments_json (and later approval-listing output) don't
    // leak the operator passphrase or similar secrets.
    const request = approvals.createRequest({
      toolName,
      arguments: redactForStorage(args as Record<string, unknown>, redactFields),
    });

    return pendingResult({
      approved: false,
      requestId: request.requestId,
      state: 'pending',
      message: `tool '${toolName}' requires operator approval. Request ID: ${request.requestId}. Operator: run 'memphis config tools approve-call ${request.requestId}'`,
    });
  };
}

export function createMemphisMcpServer(
  manifest?: SoulManifest,
  rawEnv: NodeJS.ProcessEnv = process.env,
): McpServer {
  const server = new McpServer({
    name: 'memphis-mcp',
    version: '0.3.4',
  });

  const { permissions, approvals } = getRepos(rawEnv);
  const evolveDeps = getEvolveDeps(rawEnv);
  const resolvedManifest = manifest ?? ensureSoulManifest(rawEnv);

  const journalPolicy = getToolPolicy(permissions, 'memphis_journal', resolvedManifest);
  if (shouldRegisterTool('memphis_journal', journalPolicy, rawEnv)) {
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
  if (shouldRegisterTool('memphis_recall', recallPolicy, rawEnv)) {
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
  if (shouldRegisterTool('memphis_search', searchPolicy, rawEnv)) {
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
  if (shouldRegisterTool('memphis_decide', decidePolicy, rawEnv)) {
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
  if (shouldRegisterTool('memphis_health', healthPolicy, rawEnv)) {
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

  const providersPolicy = getToolPolicy(permissions, 'memphis_providers', resolvedManifest);
  if (shouldRegisterTool('memphis_providers', providersPolicy, rawEnv)) {
    server.registerTool(
      'memphis_providers',
      {
        description: 'Inspect configured providers, default models, and discovered model lists',
        inputSchema: {
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_providers', providersPolicy, approvals, async () => {
        const result = await runMemphisProviders();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    );
  }

  const systemInfoPolicy = getToolPolicy(permissions, 'memphis_system_info', resolvedManifest);
  if (shouldRegisterTool('memphis_system_info', systemInfoPolicy, rawEnv)) {
    server.registerTool(
      'memphis_system_info',
      {
        description: 'Inspect host and Memphis runtime system details',
        inputSchema: {
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_system_info', systemInfoPolicy, approvals, async () => {
        const result = runMemphisSystemInfo();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    );
  }

  const webFetchPolicy = getToolPolicy(permissions, 'memphis_web_fetch', resolvedManifest);
  if (shouldRegisterTool('memphis_web_fetch', webFetchPolicy, rawEnv)) {
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
  if (shouldRegisterTool('memphis_code_read', codeReadPolicy, rawEnv)) {
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

  const grepPolicy = getToolPolicy(permissions, 'memphis_grep', resolvedManifest);
  if (shouldRegisterTool('memphis_grep', grepPolicy, rawEnv)) {
    server.registerTool(
      'memphis_grep',
      {
        description: 'Search code using regex patterns (ripgrep or grep)',
        inputSchema: {
          pattern: z.string().min(1).max(500),
          path: z.string().optional(),
          glob: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional(),
          context: z.number().int().min(0).max(10).optional(),
          ignoreCase: z.boolean().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_grep', grepPolicy, approvals, async ({ pattern, path, glob, limit, context, ignoreCase }) => {
        const result = runMemphisGrep({ pattern, path, glob, limit, context, ignoreCase });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
    );
  }

  const globPolicy = getToolPolicy(permissions, 'memphis_glob', resolvedManifest);
  if (shouldRegisterTool('memphis_glob', globPolicy, rawEnv)) {
    server.registerTool(
      'memphis_glob',
      {
        description: 'Find files by glob pattern (fd or find)',
        inputSchema: {
          pattern: z.string().min(1).max(300),
          path: z.string().optional(),
          limit: z.number().int().min(1).max(500).optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_glob', globPolicy, approvals, async ({ pattern, path, limit }) => {
        const result = runMemphisGlob({ pattern, path, limit });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
    );
  }

  const gitPolicy = getToolPolicy(permissions, 'memphis_git', resolvedManifest);
  if (shouldRegisterTool('memphis_git', gitPolicy, rawEnv)) {
    server.registerTool(
      'memphis_git',
      {
        description: 'Git operations — status, log, diff, add, commit, push',
        inputSchema: {
          subcommand: z.string().min(1),
          args: z.array(z.string()).optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_git', gitPolicy, approvals, async ({ subcommand, args }) => {
        const result = runMemphisGit({ subcommand, args });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
    );
  }

  const loopStepPolicy = getToolPolicy(permissions, 'memphis_loop_step', resolvedManifest);
  if (shouldRegisterTool('memphis_loop_step', loopStepPolicy, rawEnv)) {
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

  const testPolicy = getToolPolicy(permissions, 'memphis_test', resolvedManifest);
  if (shouldRegisterTool('memphis_test', testPolicy, rawEnv)) {
    server.registerTool(
      'memphis_test',
      {
        description: 'Run project tests (typecheck, lint, vitest, cargo test)',
        inputSchema: {
          suite: z.enum(['ts', 'rust', 'lint', 'typecheck', 'all']).optional(),
          filter: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_test', testPolicy, approvals, async ({ suite, filter }) => {
        const result = runMemphisTest({ suite, filter });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
    );
  }

  const deployPolicy = getToolPolicy(permissions, 'memphis_deploy', resolvedManifest);
  if (shouldRegisterTool('memphis_deploy', deployPolicy, rawEnv)) {
    server.registerTool(
      'memphis_deploy',
      {
        description:
          'Run deploy, health, and rollback workflows with snapshots, test gates, and post-deploy checks',
        inputSchema: {
          action: z.enum(['run', 'health', 'rollback']).optional(),
          profile: z.enum(['local-service', 'build-only', 'custom']).optional(),
          buildCommand: z.string().min(1).optional(),
          deployCommand: z.string().min(1).optional(),
          healthUrl: z.string().url().optional(),
          testSuite: z.enum(['ts', 'rust', 'lint', 'typecheck', 'all']).optional(),
          deep: z.boolean().optional(),
          dryRun: z.boolean().optional(),
          rollbackIndex: z.number().int().min(1).optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_deploy',
        deployPolicy,
        approvals,
        async ({
          action,
          profile,
          buildCommand,
          deployCommand,
          healthUrl,
          testSuite,
          deep,
          dryRun,
          rollbackIndex,
        }) => {
          const result = await runMemphisDeploy({
            action,
            profile,
            buildCommand,
            deployCommand,
            healthUrl,
            testSuite,
            deep,
            dryRun,
            rollbackIndex,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        },
      ),
    );
  }

  const execPolicy = getToolPolicy(permissions, 'memphis_exec', resolvedManifest);
  if (shouldRegisterTool('memphis_exec', execPolicy, rawEnv)) {
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
          const result = runMemphisExec({ command }, rawEnv);
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
  if (shouldRegisterTool('memphis_case_append', caseAppendPolicy, rawEnv)) {
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
  if (shouldRegisterTool('memphis_case_query', caseQueryPolicy, rawEnv)) {
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

  const chainQueryPolicy = getToolPolicy(permissions, 'memphis_chain_query', resolvedManifest);
  if (shouldRegisterTool('memphis_chain_query', chainQueryPolicy, rawEnv)) {
    server.registerTool(
      'memphis_chain_query',
      {
        description: 'Query raw chain blocks with optional chain, type, content, and tag filters',
        inputSchema: {
          chain: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          offset: z.number().int().min(0).max(1000).optional(),
          blockType: z.string().optional(),
          contains: z.string().optional(),
          tag: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_chain_query',
        chainQueryPolicy,
        approvals,
        async ({ chain, limit, offset, blockType, contains, tag }) => {
          const result = await runMemphisChainQuery({
            chain,
            limit,
            offset,
            blockType,
            contains,
            tag,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        },
      ),
    );
  }

  const soulReadPolicy = getToolPolicy(permissions, 'memphis_soul_read', resolvedManifest);
  if (shouldRegisterTool('memphis_soul_read', soulReadPolicy, rawEnv)) {
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
  if (shouldRegisterTool('memphis_soul_write', soulWritePolicy, rawEnv)) {
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
  if (shouldRegisterTool('memphis_self_modify', selfModifyPolicy, rawEnv)) {
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

  // ── Foundation tools (Phase 1) ────────────────────────────────────

  const fsWritePolicy = getToolPolicy(permissions, 'memphis_fs_write', resolvedManifest);
  if (shouldRegisterTool('memphis_fs_write', fsWritePolicy, rawEnv)) {
    server.registerTool(
      'memphis_fs_write',
      {
        description:
          'Write/append/overwrite files. Full access inside ~/memphis/. ' +
          'Outside, create-new only; append or overwrite needs tier 3.',
        inputSchema: {
          path: z.string().min(1),
          content: z.string(),
          mode: z.enum(['write', 'append', 'overwrite']).optional(),
          createDirs: z.boolean().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_fs_write',
        fsWritePolicy,
        approvals,
        async ({ path, content, mode, createDirs }) => {
          const result = runMemphisFsWrite({ path, content, mode, createDirs });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        },
      ),
    );
  }

  const fsOpsPolicy = getToolPolicy(permissions, 'memphis_fs_ops', resolvedManifest);
  if (shouldRegisterTool('memphis_fs_ops', fsOpsPolicy, rawEnv)) {
    server.registerTool(
      'memphis_fs_ops',
      {
        description:
          'Filesystem operations: copy, move, delete, mkdir, stat. ' +
          'Destructive ops on existing paths outside ~/memphis/ require tier 3.',
        inputSchema: {
          operation: z.enum(['copy', 'move', 'delete', 'mkdir', 'stat']),
          source: z.string().min(1),
          destination: z.string().optional(),
          recursive: z.boolean().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_fs_ops',
        fsOpsPolicy,
        approvals,
        async ({ operation, source, destination, recursive }) => {
          const result = runMemphisFsOps({ operation, source, destination, recursive });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        },
      ),
    );
  }

  const webSearchPolicy = getToolPolicy(permissions, 'memphis_web_search', resolvedManifest);
  if (shouldRegisterTool('memphis_web_search', webSearchPolicy, rawEnv)) {
    server.registerTool(
      'memphis_web_search',
      {
        description: 'Search the web via DuckDuckGo',
        inputSchema: {
          query: z.string().min(1),
          limit: z.number().int().min(1).max(10).optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_web_search',
        webSearchPolicy,
        approvals,
        async ({ query, limit }) => {
          const result = await runMemphisWebSearch({ query, limit });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        },
      ),
    );
  }

  const packagePolicy = getToolPolicy(permissions, 'memphis_package', resolvedManifest);
  if (shouldRegisterTool('memphis_package', packagePolicy, rawEnv)) {
    server.registerTool(
      'memphis_package',
      {
        description: 'Package manager operations (npm, cargo, apt, pip)',
        inputSchema: {
          manager: z.enum(['npm', 'cargo', 'apt', 'pip']),
          action: z.enum(['install', 'remove', 'list', 'search']),
          packages: z.array(z.string()).optional(),
          global: z.boolean().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_package',
        packagePolicy,
        approvals,
        async ({ manager, action, packages, global: isGlobal }) => {
          const result = runMemphisPackage({ manager, action, packages, global: isGlobal });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        },
      ),
    );
  }

  const dbPolicy = getToolPolicy(permissions, 'memphis_db', resolvedManifest);
  if (shouldRegisterTool('memphis_db', dbPolicy, rawEnv)) {
    server.registerTool(
      'memphis_db',
      {
        description: 'Query and manage SQLite databases',
        inputSchema: {
          action: z.enum(['query', 'execute', 'tables', 'schema']),
          sql: z.string().optional(),
          database: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_db', dbPolicy, approvals, async ({ action, sql, database }) => {
        const result = runMemphisDb({ action, sql, database });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    );
  }

  // ── Build/deploy tools (Phase 1) ───────────────────────────────────

  const buildPolicy = getToolPolicy(permissions, 'memphis_build', resolvedManifest);
  if (shouldRegisterTool('memphis_build', buildPolicy, rawEnv)) {
    server.registerTool(
      'memphis_build',
      {
        description: 'Auto-detect project type and run build',
        inputSchema: {
          project: z.string().optional(),
          command: z.string().optional(),
          profile: z.enum(['debug', 'release']).optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_build',
        buildPolicy,
        approvals,
        async ({ project, command, profile }) => {
          const result = runMemphisBuild({ project, command, profile });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        },
      ),
    );
  }

  const healthCheckPolicy = getToolPolicy(permissions, 'memphis_health_check', resolvedManifest);
  if (shouldRegisterTool('memphis_health_check', healthCheckPolicy, rawEnv)) {
    server.registerTool(
      'memphis_health_check',
      {
        description: 'HTTP health checks against targets',
        inputSchema: {
          targets: z.array(
            z.object({
              url: z.string().min(1),
              timeout: z.number().int().min(100).max(30000).optional(),
              expectedStatus: z.number().int().optional(),
            }),
          ),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_health_check',
        healthCheckPolicy,
        approvals,
        async ({ targets }) => {
          const result = await runMemphisHealthCheck({ targets });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        },
      ),
    );
  }

  // ── Sprint 7: surface parity — expose TUI-host capabilities to MCP ────────
  // These tools are the MCP mirror of TUI host capabilities `presence.snapshot`
  // (Sprint 5), `config.show`, and `config.reload` (Sprint 6). Adding them
  // here gives any MCP-speaking client the same capability ceiling as TUI.

  const presencePolicy = getToolPolicy(permissions, 'memphis_presence', resolvedManifest);
  if (shouldRegisterTool('memphis_presence', presencePolicy, rawEnv)) {
    server.registerTool(
      'memphis_presence',
      {
        description:
          'Cross-surface presence snapshot — which surfaces (TUI, Telegram, HTTP) are active and when they last acted.',
        inputSchema: {
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_presence', presencePolicy, approvals, async () => {
        const result = runMemphisPresence();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    );
  }

  const configShowPolicy = getToolPolicy(permissions, 'memphis_config_show', resolvedManifest);
  if (shouldRegisterTool('memphis_config_show', configShowPolicy, rawEnv)) {
    server.registerTool(
      'memphis_config_show',
      {
        description:
          'Show current runtime config values (redacted). Pass `key` to narrow to one field; omit to list every known field.',
        inputSchema: {
          key: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_config_show',
        configShowPolicy,
        approvals,
        async ({ key }) => {
          const result = runMemphisConfigShow({ key });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        },
      ),
    );
  }

  const configReloadPolicy = getToolPolicy(permissions, 'memphis_config_reload', resolvedManifest);
  if (shouldRegisterTool('memphis_config_reload', configReloadPolicy, rawEnv)) {
    server.registerTool(
      'memphis_config_reload',
      {
        description:
          'Re-read .env, validate, swap hot/warm fields; refuse cold-field changes (restart required). Returns the redacted diff.',
        inputSchema: {
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_config_reload', configReloadPolicy, approvals, async () => {
        const result = await runMemphisConfigReload();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    );
  }

  const restartPolicy = getToolPolicy(permissions, 'memphis_restart', resolvedManifest);
  if (shouldRegisterTool('memphis_restart', restartPolicy, rawEnv)) {
    server.registerTool(
      'memphis_restart',
      {
        description:
          'Self-restart the Memphis agent. Requires the operator passphrase (MCP has no session-based tier-3 flow). Refuses cleanly when no process supervisor is detected unless MEMPHIS_RESTART_ALLOW_SUICIDE=true.',
        inputSchema: {
          reason: z.string().optional(),
          actor_id: z.string().optional(),
          // Codex P1 (Round 2): operator passphrase required when operator
          // config is set. Without it the engine refuses with not-elevated.
          passphrase: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_restart',
        restartPolicy,
        approvals,
        async ({ reason, actor_id, passphrase }) => {
          const result = await runMemphisRestart({ reason, actor_id, passphrase });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        },
        // Codex P1 (Round 4): `passphrase` must not be persisted to the
        // approvals SQLite table nor echoed by operator-facing listing
        // commands. Redact before store.
        ['passphrase'],
      ),
    );
  }

  return server;
}
