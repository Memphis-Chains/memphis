import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// Codex Round 5 P2 fix: registers the LOG_LEVEL post-apply hook. Without
// this, MCP-only startup paths (serveMcpStdio/serveMcpHttp) that don't
// import bootstrap.ts would miss the hook registration, so /config
// reload would accept LOG_LEVEL as hot but live loggers kept their old
// threshold until restart.
import '../infra/logging/contextual.js';

import { runMemphisBraveSearch } from './tools/brave-search.js';
import { runMemphisBuild } from './tools/build.js';
import {
  normalizeCaseAppendInput,
  runMemphisCaseAppend,
  runMemphisCaseQuery,
} from './tools/case-entry.js';
import { runMemphisChainQuery } from './tools/chain-query.js';
import { runMemphisChainVerify } from './tools/chain-verify.js';
import { runMemphisCodeRead } from './tools/code-read.js';
import {
  runMemphisCognitiveModeSet,
  runMemphisConfigReload,
  runMemphisConfigSet,
  runMemphisConfigShow,
} from './tools/config.js';
import { runMemphisCron } from './tools/cron.js';
import { runMemphisDb } from './tools/db.js';
import { runMemphisDecide } from './tools/decide.js';
import { runMemphisDeploy } from './tools/deploy.js';
import { runMemphisExecAnalyze } from './tools/exec-analyze.js';
import { runMemphisExec } from './tools/exec.js';
import { runMemphisFsOps } from './tools/fs-ops.js';
import { runMemphisFsWrite } from './tools/fs-write.js';
import { runMemphisGit } from './tools/git.js';
import { runMemphisGlob } from './tools/glob.js';
import { runMemphisGrep } from './tools/grep.js';
import { runMemphisHealthCheck } from './tools/health-check.js';
import { runMemphisHealth } from './tools/health.js';
import { runMemphisJournal } from './tools/journal.js';
import { runMemphisKartograf } from './tools/kartograf.js';
import { runMemphisLoopStep } from './tools/loop-step.js';
import { lrDashboardToolInputSchema, runMemphisLrDashboard } from './tools/lr-dashboard.js';
import { runMemphisMediaIngest } from './tools/media-ingest.js';
import { runMemphisPackage } from './tools/package.js';
import { runMemphisPresence } from './tools/presence.js';
import { runMemphisProviders } from './tools/providers.js';
import { runMemphisRecall } from './tools/recall.js';
import { runMemphisRepair } from './tools/repair.js';
import { runMemphisRestart } from './tools/restart.js';
import { runMemphisSearch } from './tools/search.js';
import { runMemphisSelfDeployVerify } from './tools/self-deploy-verify.js';
import { runMemphisSelfDescribe } from './tools/self-describe.js';
import { runMemphisSelfGovernanceStatus } from './tools/self-governance-status.js';
import { runMemphisSelfModify } from './tools/self-modify.js';
import {
  runMemphisSelfPlanAdvance,
  runMemphisSelfPlanCancel,
  runMemphisSelfPlanCreate,
  runMemphisSelfPlanGet,
} from './tools/self-plan.js';
import { runMemphisSelfPrOpen } from './tools/self-pr-open.js';
import { runMemphisSelfReview } from './tools/self-review.js';
import {
  runMemphisSkillCreate,
  runMemphisSkillInstall,
  runMemphisSkillList,
  runMemphisSkillShow,
  runMemphisSkillValidate,
} from './tools/skill.js';
import { runMemphisSloStatus } from './tools/slo-status.js';
import { runMemphisSoulRead, runMemphisSoulWrite } from './tools/soul.js';
import { runMemphisSystemInfo } from './tools/system-info.js';
import { runMemphisTensorStatus } from './tools/tensor-status.js';
import { runMemphisTest } from './tools/test-run.js';
import { runMemphisWebFetch } from './tools/web-fetch.js';
import { runMemphisWebSearch } from './tools/web-search.js';
import { RollbackManager } from '../backup/rollback.js';
import { resolveToolPolicy } from '../gateway/authorization.js';
import {
  TOOL_REGISTRY,
  getToolDescription,
  isToolEnabledByFeatureFlag,
} from '../gateway/tool-registry.js';
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

function registryMcpInputSchema(toolName: string): z.ZodRawShape {
  const schema = TOOL_REGISTRY[toolName]?.inputSchema;
  const maybeShape =
    (schema as { shape?: unknown; _def?: { shape?: unknown } } | undefined)?.shape ??
    (schema as { _def?: { shape?: unknown } } | undefined)?._def?.shape;
  const shape = typeof maybeShape === 'function' ? maybeShape() : maybeShape;
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) {
    throw new Error(`No registry Zod object inputSchema found for MCP tool ${toolName}`);
  }
  return shape as z.ZodRawShape;
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' ? value : undefined;
}

function optionalBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

function optionalNonnegativeIntegerArg(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = optionalNumberArg(args, key);
  if (value === undefined) return undefined;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function optionalIntegerInRangeArg(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max?: number,
): number | undefined {
  const value = optionalNumberArg(args, key);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    return undefined;
  }
  return value;
}

function requiredStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new Error(`MCP tool argument ${key} must be a string`);
  }
  return value;
}

function requiredStringArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`MCP tool argument ${key} must be a string array`);
  }
  return value;
}

function requiredStringRecordArg(
  args: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`MCP tool argument ${key} must be a string record`);
  }
  const entries = Object.entries(value);
  if (!entries.every(([, entryValue]) => typeof entryValue === 'string')) {
    throw new Error(`MCP tool argument ${key} must be a string record`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
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
 * Coerce arbitrary JSON-serialisable tool output into the shape MCP's
 * `structuredContent` requires (Record<string, unknown>). Sprint 3.2
 * replaces 23 instances of inline `result as unknown as Record<string,
 * unknown>` casts at tool registration sites — same outcome, single
 * point of maintenance, and a runtime guard for primitive returns
 * (which would otherwise silently violate the MCP type contract).
 *
 * Tool handlers in src/mcp/tools/ uniformly return objects today; this
 * helper just removes the casting boilerplate. If a handler ever
 * returns a primitive or array, we wrap it in `{ value: ... }` so the
 * MCP envelope stays well-formed instead of crashing the SDK validator.
 */
function toJsonRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
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
        description: getToolDescription('memphis_journal'),
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
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    );
  }

  const kartografPolicy = getToolPolicy(permissions, 'memphis_kartograf', resolvedManifest);
  if (shouldRegisterTool('memphis_kartograf', kartografPolicy, rawEnv)) {
    server.registerTool(
      'memphis_kartograf',
      {
        description: getToolDescription('memphis_kartograf'),
        inputSchema: {
          query: z.string().min(1).max(8192),
          top_k_zones: z.number().int().min(1).max(12).optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_kartograf',
        kartografPolicy,
        approvals,
        async ({ query, top_k_zones }) => {
          const result = await runMemphisKartograf({
            query,
            ...(top_k_zones !== undefined ? { top_k_zones } : {}),
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        },
      ),
    );
  }

  const lrDashboardPolicy = getToolPolicy(permissions, 'memphis_lr_dashboard', resolvedManifest);
  if (shouldRegisterTool('memphis_lr_dashboard', lrDashboardPolicy, rawEnv)) {
    server.registerTool(
      'memphis_lr_dashboard',
      {
        description: getToolDescription('memphis_lr_dashboard'),
        inputSchema: registryMcpInputSchema('memphis_lr_dashboard'),
      },
      withApprovalGate('memphis_lr_dashboard', lrDashboardPolicy, approvals, async (args) => {
        const result = runMemphisLrDashboard(lrDashboardToolInputSchema.parse(args), rawEnv);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    );
  }

  const recallPolicy = getToolPolicy(permissions, 'memphis_recall', resolvedManifest);
  if (shouldRegisterTool('memphis_recall', recallPolicy, rawEnv)) {
    server.registerTool(
      'memphis_recall',
      {
        description: getToolDescription('memphis_recall'),
        inputSchema: registryMcpInputSchema('memphis_recall'),
      },
      withApprovalGate('memphis_recall', recallPolicy, approvals, async (args) => {
        const result = runMemphisRecall({
          query: requiredStringArg(args, 'query'),
          limit: optionalIntegerInRangeArg(args, 'limit', 1, 50),
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    );
  }

  const searchPolicy = getToolPolicy(permissions, 'memphis_search', resolvedManifest);
  if (shouldRegisterTool('memphis_search', searchPolicy, rawEnv)) {
    server.registerTool(
      'memphis_search',
      {
        description: getToolDescription('memphis_search'),
        inputSchema: registryMcpInputSchema('memphis_search'),
      },
      withApprovalGate('memphis_search', searchPolicy, approvals, async (args) => {
        const result = runMemphisSearch({
          query: requiredStringArg(args, 'query'),
          limit: optionalIntegerInRangeArg(args, 'limit', 1, 50),
          chain: optionalStringArg(args, 'chain'),
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
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
        description: getToolDescription('memphis_health'),
        inputSchema: registryMcpInputSchema('memphis_health'),
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

  const selfGovernancePolicy = getToolPolicy(
    permissions,
    'memphis_self_governance_status',
    resolvedManifest,
  );
  if (shouldRegisterTool('memphis_self_governance_status', selfGovernancePolicy, rawEnv)) {
    server.registerTool(
      'memphis_self_governance_status',
      {
        description: getToolDescription('memphis_self_governance_status'),
        inputSchema: registryMcpInputSchema('memphis_self_governance_status'),
      },
      withApprovalGate(
        'memphis_self_governance_status',
        selfGovernancePolicy,
        approvals,
        async () => {
          const result = await runMemphisSelfGovernanceStatus(rawEnv);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
          };
        },
      ),
    );
  }

  const tensorStatusPolicy = getToolPolicy(permissions, 'memphis_tensor_status', resolvedManifest);
  if (shouldRegisterTool('memphis_tensor_status', tensorStatusPolicy, rawEnv)) {
    server.registerTool(
      'memphis_tensor_status',
      {
        description: getToolDescription('memphis_tensor_status'),
        inputSchema: registryMcpInputSchema('memphis_tensor_status'),
      },
      withApprovalGate('memphis_tensor_status', tensorStatusPolicy, approvals, async () => {
        const result = runMemphisTensorStatus(rawEnv);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    );
  }

  // Wiring W1 (sprint marathon follow-up): memphis_self_describe was added
  // in PR #310 to close the "what can you do" confabulation gap, but the
  // MCP server registration was missed — external MCP clients (Claude
  // Desktop, MCP Inspector, etc.) couldn't see the tool that was
  // designed precisely for them. The in-process executor + system prompt
  // already register it; this block fills the third surface.
  const selfDescribePolicy = getToolPolicy(permissions, 'memphis_self_describe', resolvedManifest);
  if (shouldRegisterTool('memphis_self_describe', selfDescribePolicy, rawEnv)) {
    server.registerTool(
      'memphis_self_describe',
      {
        description:
          'Runtime self-introspection — active surface, effective tier, cognitive mode, full tool inventory with availability, feature flags, cross-surface tier-3 sessions. Call BEFORE answering "what can you do" questions instead of guessing from training data.',
        inputSchema: registryMcpInputSchema('memphis_self_describe'),
      },
      withApprovalGate('memphis_self_describe', selfDescribePolicy, approvals, async (args) => {
        const result = runMemphisSelfDescribe(
          {
            surface: optionalStringArg(args, 'surface'),
            actorId: optionalStringArg(args, 'actorId'),
          },
          rawEnv,
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
        };
      }),
    );
  }

  // ─── First-class skill tools (PR #572, 2026-05-12) ─────────────────────
  // Mirror in-process executor entries so MCP clients (Tauri GUI, custom
  // adapters) reach the same surface as Memphis's own tool calls.
  const skillListPolicy = getToolPolicy(permissions, 'memphis_skill_list', resolvedManifest);
  if (shouldRegisterTool('memphis_skill_list', skillListPolicy, rawEnv)) {
    server.registerTool(
      'memphis_skill_list',
      {
        description:
          'List Memphis skills (built-in + local catalog + installed). Filter by installed/draft/all.',
        inputSchema: {
          filter: z.enum(['all', 'installed', 'draft']).optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_skill_list', skillListPolicy, approvals, async (args) => {
        const result = runMemphisSkillList({ filter: args.filter }, rawEnv);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
        };
      }),
    );
  }

  const skillShowPolicy = getToolPolicy(permissions, 'memphis_skill_show', resolvedManifest);
  if (shouldRegisterTool('memphis_skill_show', skillShowPolicy, rawEnv)) {
    server.registerTool(
      'memphis_skill_show',
      {
        description:
          'Show full skill manifest (workflow, prompt hints, examples, notes) by id or file path.',
        inputSchema: {
          id: z.string().optional(),
          file: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_skill_show', skillShowPolicy, approvals, async (args) => {
        const result = runMemphisSkillShow({ id: args.id, file: args.file }, rawEnv);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
        };
      }),
    );
  }

  const skillCreatePolicy = getToolPolicy(permissions, 'memphis_skill_create', resolvedManifest);
  if (shouldRegisterTool('memphis_skill_create', skillCreatePolicy, rawEnv)) {
    server.registerTool(
      'memphis_skill_create',
      {
        description:
          'Scaffold a draft skill manifest with placeholder workflow + hints. Returns paths to edit, then call memphis_skill_validate and memphis_skill_install.',
        inputSchema: {
          id: z.string().min(1),
          name: z.string().optional(),
          description: z.string().optional(),
          tools: z.array(z.string()).optional(),
          out: z.string().optional(),
          force: z.boolean().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_skill_create', skillCreatePolicy, approvals, async (args) => {
        const result = runMemphisSkillCreate(
          {
            id: args.id,
            name: args.name,
            description: args.description,
            tools: args.tools,
            out: args.out,
            force: args.force,
          },
          rawEnv,
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
        };
      }),
    );
  }

  const skillValidatePolicy = getToolPolicy(
    permissions,
    'memphis_skill_validate',
    resolvedManifest,
  );
  if (shouldRegisterTool('memphis_skill_validate', skillValidatePolicy, rawEnv)) {
    server.registerTool(
      'memphis_skill_validate',
      {
        description:
          'Validate a skill manifest BEFORE install: schema shape + every declared tool must exist in TOOL_REGISTRY. Returns {ok, suggestedFix?} for iteration without polluting the catalog.',
        inputSchema: {
          id: z.string().optional(),
          file: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_skill_validate', skillValidatePolicy, approvals, async (args) => {
        const result = runMemphisSkillValidate({ id: args.id, file: args.file }, rawEnv);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
        };
      }),
    );
  }

  const skillInstallPolicy = getToolPolicy(permissions, 'memphis_skill_install', resolvedManifest);
  if (shouldRegisterTool('memphis_skill_install', skillInstallPolicy, rawEnv)) {
    server.registerTool(
      'memphis_skill_install',
      {
        description:
          'Validate + promote a draft skill to catalog + installed dirs and update the skills registry. Refuses on schema or unknown-tool errors.',
        inputSchema: {
          id: z.string().optional(),
          file: z.string().optional(),
          force: z.boolean().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_skill_install', skillInstallPolicy, approvals, async (args) => {
        const result = runMemphisSkillInstall(
          { id: args.id, file: args.file, force: args.force },
          rawEnv,
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
        };
      }),
    );
  }

  const sloStatusPolicy = getToolPolicy(permissions, 'memphis_slo_status', resolvedManifest);
  if (shouldRegisterTool('memphis_slo_status', sloStatusPolicy, rawEnv)) {
    server.registerTool(
      'memphis_slo_status',
      {
        description:
          'Runtime SLO snapshot — reads telemetry spans over a time window (default 7 days) and reports each SLO as pass/fail/unavailable with computed value, threshold, and sample count.',
        inputSchema: registryMcpInputSchema('memphis_slo_status'),
      },
      withApprovalGate('memphis_slo_status', sloStatusPolicy, approvals, async (args) => {
        const result = runMemphisSloStatus(
          { windowDays: optionalNumberArg(args, 'windowDays') },
          rawEnv,
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
        };
      }),
    );
  }

  // Wiring W1: memphis_repair — runtime state repair (chain integrity,
  // SQLite, migrations, derived indexes). Tier 0 read-equivalent (it's
  // safe to invoke), already wired in the in-process executor; was
  // missing from MCP server.
  const repairPolicy = getToolPolicy(permissions, 'memphis_repair', resolvedManifest);
  if (shouldRegisterTool('memphis_repair', repairPolicy, rawEnv)) {
    server.registerTool(
      'memphis_repair',
      {
        description:
          'Repair Memphis runtime state — chain integrity, SQLite, migrations, derived indexes',
        inputSchema: registryMcpInputSchema('memphis_repair'),
      },
      withApprovalGate('memphis_repair', repairPolicy, approvals, async (args) => {
        const result = await runMemphisRepair({ force: optionalBooleanArg(args, 'force') });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
        };
      }),
    );
  }

  // Wiring W1: memphis_cron — scheduled-task management (list/add/remove/
  // enable/disable). Tier 2 — reachable from operator/telegram surfaces;
  // already wired in the in-process executor; was missing from MCP server.
  const cronPolicy = getToolPolicy(permissions, 'memphis_cron', resolvedManifest);
  if (shouldRegisterTool('memphis_cron', cronPolicy, rawEnv)) {
    server.registerTool(
      'memphis_cron',
      {
        description: 'Manage scheduled tasks (list, add, remove, enable, disable)',
        inputSchema: {
          action: z.enum(['list', 'add', 'remove', 'enable', 'disable']),
          cron: z.string().optional(),
          name: z.string().optional(),
          taskType: z.enum(['shell', 'reflection', 'git-pull-build', 'http']).optional(),
          script: z.string().optional(),
          url: z.string().optional(),
          method: z.string().optional(),
          taskId: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_cron', cronPolicy, approvals, async (args) => {
        const result = runMemphisCron(args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
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
          structuredContent: toJsonRecord(result),
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
          structuredContent: toJsonRecord(result),
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
        const result = await runMemphisWebFetch(
          { url },
          {
            allowPrivateNetwork:
              (rawEnv.MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK ?? '').toLowerCase() === 'true',
          },
        );
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
        inputSchema: registryMcpInputSchema('memphis_code_read'),
      },
      withApprovalGate('memphis_code_read', codeReadPolicy, approvals, async (args) => {
        const result = runMemphisCodeRead({
          path: requiredStringArg(args, 'path'),
          startLine: optionalIntegerInRangeArg(args, 'startLine', 1),
          endLine: optionalIntegerInRangeArg(args, 'endLine', 1),
          limit: optionalIntegerInRangeArg(args, 'limit', 1, 2000),
        });
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
      withApprovalGate(
        'memphis_grep',
        grepPolicy,
        approvals,
        async ({ pattern, path, glob, limit, context, ignoreCase }) => {
          const result = runMemphisGrep({ pattern, path, glob, limit, context, ignoreCase });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
          };
        },
      ),
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
            structuredContent: toJsonRecord(result),
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
            structuredContent: toJsonRecord(result),
          };
        },
      ),
    );
  }

  const execAnalyzePolicy = getToolPolicy(permissions, 'memphis_exec_analyze', resolvedManifest);
  if (shouldRegisterTool('memphis_exec_analyze', execAnalyzePolicy, rawEnv)) {
    server.registerTool(
      'memphis_exec_analyze',
      {
        description:
          'Pre-exec analysis: parse + classify side-effects, reversibility, dry-run hint, recommendation. No side effects.',
        inputSchema: {
          command: z.string().min(1).max(2048),
          surface_intent: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_exec_analyze',
        execAnalyzePolicy,
        approvals,
        async ({ command, surface_intent }) => {
          const result = runMemphisExecAnalyze({ command, surface_intent });
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
          surface_intent: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_exec',
        execPolicy,
        approvals,
        async ({ command, surface_intent }) => {
          try {
            const result = runMemphisExec({ command, surface_intent }, rawEnv);
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
        },
      ),
    );
  }

  const caseAppendPolicy = getToolPolicy(permissions, 'memphis_case_append', resolvedManifest);
  if (shouldRegisterTool('memphis_case_append', caseAppendPolicy, rawEnv)) {
    const caseTypeSchema = z.enum([
      'nominative',
      'genitive',
      'dative',
      'accusative',
      'instrumental',
      'locative',
      'ablative',
      'vocative',
    ]);
    server.registerTool(
      'memphis_case_append',
      {
        description:
          'Append a case entry to the cognitive knowledge graph. Accepts either {entry:{case_type,...}} or top-level {case_type,...}.',
        inputSchema: {
          entry: z.object({ case_type: caseTypeSchema }).passthrough().optional(),
          case_type: caseTypeSchema.optional(),
          entity: z.string().optional(),
          action: z.string().optional(),
          timestamp: z.string().optional(),
          owner: z.string().optional(),
          possessed: z.string().optional(),
          giver: z.string().optional(),
          recipient: z.string().optional(),
          object: z.string().optional(),
          subject: z.string().optional(),
          verb: z.string().optional(),
          actor: z.string().optional(),
          instrument: z.string().optional(),
          target: z.string().optional(),
          location: z.string().optional(),
          origin: z.string().optional(),
          destination: z.string().optional(),
          invoker: z.string().optional(),
          invocation: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_case_append', caseAppendPolicy, approvals, async (args) => {
        const result = await runMemphisCaseAppend(normalizeCaseAppendInput(args as never));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
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
          structuredContent: toJsonRecord(result),
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
            structuredContent: toJsonRecord(result),
          };
        },
      ),
    );
  }

  const chainVerifyPolicy = getToolPolicy(permissions, 'memphis_chain_verify', resolvedManifest);
  if (shouldRegisterTool('memphis_chain_verify', chainVerifyPolicy, rawEnv)) {
    server.registerTool(
      'memphis_chain_verify',
      {
        description:
          'Authoritatively verify chain hashes, indexes, and prev-hash links before diagnosing corruption',
        inputSchema: {
          chain: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_chain_verify', chainVerifyPolicy, approvals, async ({ chain }) => {
        const result = await runMemphisChainVerify({ chain }, rawEnv);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
        };
      }),
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
          structuredContent: toJsonRecord(result),
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
          structuredContent: toJsonRecord(result),
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
        inputSchema: registryMcpInputSchema('memphis_self_modify'),
      },
      withApprovalGate('memphis_self_modify', selfModifyPolicy, approvals, async (args) => {
        const result = await runMemphisSelfModify(
          {
            intent: requiredStringArg(args, 'intent'),
            files: requiredStringArrayArg(args, 'files'),
            changes: requiredStringRecordArg(args, 'changes'),
            passphrase: optionalStringArg(args, 'passphrase'),
            plan_id: optionalStringArg(args, 'plan_id'),
            step_idx: optionalNonnegativeIntegerArg(args, 'step_idx'),
          },
          { ...evolveDeps, rawEnv },
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
        };
      }),
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
            structuredContent: toJsonRecord(result),
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
            structuredContent: toJsonRecord(result),
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
            structuredContent: toJsonRecord(result),
          };
        },
      ),
    );
  }

  const braveSearchPolicy = getToolPolicy(permissions, 'memphis_brave_search', resolvedManifest);
  if (shouldRegisterTool('memphis_brave_search', braveSearchPolicy, rawEnv)) {
    server.registerTool(
      'memphis_brave_search',
      {
        description: getToolDescription('memphis_brave_search'),
        inputSchema: registryMcpInputSchema('memphis_brave_search'),
      },
      withApprovalGate('memphis_brave_search', braveSearchPolicy, approvals, async (args) => {
        const result = await runMemphisBraveSearch({
          query: requiredStringArg(args, 'query'),
          limit: optionalIntegerInRangeArg(args, 'limit', 1, 20),
          country: optionalStringArg(args, 'country'),
          search_lang: optionalStringArg(args, 'search_lang'),
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
        };
      }),
    );
  }

  const mediaIngestPolicy = getToolPolicy(permissions, 'memphis_media_ingest', resolvedManifest);
  if (shouldRegisterTool('memphis_media_ingest', mediaIngestPolicy, rawEnv)) {
    server.registerTool(
      'memphis_media_ingest',
      {
        description: getToolDescription('memphis_media_ingest'),
        inputSchema: {
          path: z.string().min(1),
          type: z.enum(['audio', 'image', 'video', 'auto']).optional(),
          dryRun: z.boolean().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_media_ingest',
        mediaIngestPolicy,
        approvals,
        async ({ path, type, dryRun }) => {
          const result = await runMemphisMediaIngest({ path, type, dryRun });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: toJsonRecord(result),
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
            structuredContent: toJsonRecord(result),
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
          structuredContent: toJsonRecord(result),
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
            structuredContent: toJsonRecord(result),
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
            structuredContent: toJsonRecord(result),
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
        inputSchema: registryMcpInputSchema('memphis_presence'),
      },
      withApprovalGate('memphis_presence', presencePolicy, approvals, async () => {
        const result = runMemphisPresence();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
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
      withApprovalGate('memphis_config_show', configShowPolicy, approvals, async ({ key }) => {
        const result = runMemphisConfigShow({ key });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
        };
      }),
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
          structuredContent: toJsonRecord(result),
        };
      }),
    );
  }

  // Closes deferred item #7: config.set via MCP. Secret fields require the
  // operator passphrase (validated against the same gate as memphis_restart);
  // cold fields are refused with a controlled outcome pointing at restart.
  const configSetPolicy = getToolPolicy(permissions, 'memphis_config_set', resolvedManifest);
  if (shouldRegisterTool('memphis_config_set', configSetPolicy, rawEnv)) {
    server.registerTool(
      'memphis_config_set',
      {
        description:
          'Set a single config key/value. Cold fields refuse (restart required); secret fields require the operator `passphrase` in input. Writes to .env and process.env; hot/warm post-apply hooks fire immediately.',
        inputSchema: {
          key: z.string(),
          value: z.string(),
          passphrase: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_config_set',
        configSetPolicy,
        approvals,
        async ({ key, value, passphrase }) => {
          const result = runMemphisConfigSet({ key, value, passphrase });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: toJsonRecord(result),
          };
        },
        // Both the operator credential AND the new config value (may itself
        // be a secret like an API key) stay out of the approvals table.
        ['passphrase', 'value'],
      ),
    );
  }

  // Closes deferred item #7: cognitive-mode set via MCP.
  const cognitiveModeSetPolicy = getToolPolicy(
    permissions,
    'memphis_cognitive_mode_set',
    resolvedManifest,
  );
  if (shouldRegisterTool('memphis_cognitive_mode_set', cognitiveModeSetPolicy, rawEnv)) {
    server.registerTool(
      'memphis_cognitive_mode_set',
      {
        description:
          'Switch cognitive mode (A–E). Writes the soul manifest. Requires operator `passphrase` in input (skipped only in first-run state).',
        inputSchema: {
          // Codex Round 5 P2 fix: accept case-insensitive input. The handler
          // already normalizes; the schema must not reject "b" before the
          // handler sees it.
          mode: z.preprocess(
            (v) => (typeof v === 'string' ? v.toUpperCase() : v),
            z.enum(['A', 'B', 'C', 'D', 'E']),
          ),
          passphrase: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_cognitive_mode_set',
        cognitiveModeSetPolicy,
        approvals,
        async ({ mode, passphrase }) => {
          const result = await runMemphisCognitiveModeSet({ mode, passphrase });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: toJsonRecord(result),
          };
        },
        ['passphrase'],
      ),
    );
  }

  const planCreatePolicy = getToolPolicy(permissions, 'memphis_self_plan_create', resolvedManifest);
  if (shouldRegisterTool('memphis_self_plan_create', planCreatePolicy, rawEnv)) {
    server.registerTool(
      'memphis_self_plan_create',
      {
        description:
          'Open a durable multi-step self-coding plan. Returns plan_id for use with the other memphis_self_plan_* tools.',
        inputSchema: {
          goal: z.string().min(1),
          steps: z.array(z.object({ description: z.string().min(1) }).strict()).min(1),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_self_plan_create',
        planCreatePolicy,
        approvals,
        async ({ goal, steps }) => {
          const result = runMemphisSelfPlanCreate({ goal, steps }, rawEnv);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: toJsonRecord(result),
          };
        },
      ),
    );
  }

  const planGetPolicy = getToolPolicy(permissions, 'memphis_self_plan_get', resolvedManifest);
  if (shouldRegisterTool('memphis_self_plan_get', planGetPolicy, rawEnv)) {
    server.registerTool(
      'memphis_self_plan_get',
      {
        description:
          'Read a self-coding plan by id. Returns the full plan plus next_step (first pending or failed step).',
        inputSchema: {
          plan_id: z.string().min(1),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_self_plan_get', planGetPolicy, approvals, async ({ plan_id }) => {
        const result = runMemphisSelfPlanGet({ plan_id }, rawEnv);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
        };
      }),
    );
  }

  const planAdvancePolicy = getToolPolicy(
    permissions,
    'memphis_self_plan_advance',
    resolvedManifest,
  );
  if (shouldRegisterTool('memphis_self_plan_advance', planAdvancePolicy, rawEnv)) {
    server.registerTool(
      'memphis_self_plan_advance',
      {
        description:
          'Mark a plan step as done/failed/in_progress/skipped. attempts bumps on in_progress/failed only.',
        inputSchema: {
          plan_id: z.string().min(1),
          step_idx: z.number().int().nonnegative(),
          status: z.enum(['pending', 'in_progress', 'done', 'failed', 'skipped']),
          artifact: z.string().optional(),
          error: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_self_plan_advance',
        planAdvancePolicy,
        approvals,
        async ({ plan_id, step_idx, status, artifact, error }) => {
          const result = runMemphisSelfPlanAdvance(
            { plan_id, step_idx, status, artifact, error },
            rawEnv,
          );
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: toJsonRecord(result),
          };
        },
      ),
    );
  }

  const planCancelPolicy = getToolPolicy(permissions, 'memphis_self_plan_cancel', resolvedManifest);
  if (shouldRegisterTool('memphis_self_plan_cancel', planCancelPolicy, rawEnv)) {
    server.registerTool(
      'memphis_self_plan_cancel',
      {
        description: 'Cancel a self-coding plan with a reason recorded for audit.',
        inputSchema: {
          plan_id: z.string().min(1),
          reason: z.string().min(1),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_self_plan_cancel',
        planCancelPolicy,
        approvals,
        async ({ plan_id, reason }) => {
          const result = runMemphisSelfPlanCancel({ plan_id, reason }, rawEnv);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: toJsonRecord(result),
          };
        },
      ),
    );
  }

  const selfReviewPolicy = getToolPolicy(permissions, 'memphis_self_review', resolvedManifest);
  if (shouldRegisterTool('memphis_self_review', selfReviewPolicy, rawEnv)) {
    server.registerTool(
      'memphis_self_review',
      {
        description:
          'Pre-PR review of a self-coding plan: gap, scope-creep, TODO/FIXME debt check.',
        inputSchema: {
          plan_id: z.string().min(1),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_self_review', selfReviewPolicy, approvals, async ({ plan_id }) => {
        const result = await runMemphisSelfReview({ plan_id }, { rawEnv });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: toJsonRecord(result),
        };
      }),
    );
  }

  const selfPrOpenPolicy = getToolPolicy(permissions, 'memphis_self_pr_open', resolvedManifest);
  if (shouldRegisterTool('memphis_self_pr_open', selfPrOpenPolicy, rawEnv)) {
    server.registerTool(
      'memphis_self_pr_open',
      {
        description:
          'Push the plan branch and open a PR via gh. Memphis NEVER merges — operator-only.',
        inputSchema: {
          plan_id: z.string().min(1),
          title: z.string().optional(),
          body_prefix: z.string().optional(),
          branch: z.string().optional(),
          base: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_self_pr_open',
        selfPrOpenPolicy,
        approvals,
        async ({ plan_id, title, body_prefix, branch, base }) => {
          const result = await runMemphisSelfPrOpen(
            { plan_id, title, body_prefix, branch, base },
            { rawEnv },
          );
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: toJsonRecord(result),
          };
        },
      ),
    );
  }

  const selfDeployVerifyPolicy = getToolPolicy(
    permissions,
    'memphis_self_deploy_verify',
    resolvedManifest,
  );
  if (shouldRegisterTool('memphis_self_deploy_verify', selfDeployVerifyPolicy, rawEnv)) {
    server.registerTool(
      'memphis_self_deploy_verify',
      {
        description:
          'C-step: confirm a merged plan PR shipped (merge on origin/main + build fresh).',
        inputSchema: {
          plan_id: z.string().min(1),
          build_artifact_path: z.string().optional(),
          base: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate(
        'memphis_self_deploy_verify',
        selfDeployVerifyPolicy,
        approvals,
        async ({ plan_id, build_artifact_path, base }) => {
          const result = await runMemphisSelfDeployVerify(
            { plan_id, build_artifact_path, base },
            { rawEnv },
          );
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: toJsonRecord(result),
          };
        },
      ),
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
            structuredContent: toJsonRecord(result),
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
