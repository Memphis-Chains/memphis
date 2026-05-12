/**
 * In-process tool executor — calls Memphis MCP tool functions directly,
 * no HTTP, no MCP client. Used when the gateway runs inside Memphis.
 */

import { recordAuthorizationDecision, resolveToolPolicy } from './authorization.js';
import type { ToolExecutor } from './chat-types.js';
import { isToolEnabledByFeatureFlag } from './tool-registry.js';
import { buildTool, type RuntimeToolDefinition, type ToolExecutionHook } from './tool-runtime.js';
import { RollbackManager } from '../backup/rollback.js';
import { getDataDir } from '../config/paths.js';
import { AppError } from '../core/errors.js';
import { CaseChainAdapter } from '../infra/storage/case-chain-adapter.js';
import type { SqliteEvolveSessionRepository } from '../infra/storage/sqlite/repositories/evolve-session-repository.js';
import type { SqliteToolPermissionRepository } from '../infra/storage/sqlite/repositories/tool-permission-repository.js';
import { runMemphisBraveSearch } from '../mcp/tools/brave-search.js';
import { runMemphisBuild } from '../mcp/tools/build.js';
import { runMemphisCaseAppend, runMemphisCaseQuery } from '../mcp/tools/case-entry.js';
import { runMemphisChainQuery } from '../mcp/tools/chain-query.js';
import { runMemphisCodeRead } from '../mcp/tools/code-read.js';
import {
  runMemphisCognitiveModeSet,
  runMemphisConfigReload,
  runMemphisConfigSet,
  runMemphisConfigShow,
} from '../mcp/tools/config.js';
import { runMemphisCron } from '../mcp/tools/cron.js';
import { runMemphisDb } from '../mcp/tools/db.js';
import { runMemphisDecide } from '../mcp/tools/decide.js';
import { runMemphisDeploy } from '../mcp/tools/deploy.js';
import { runMemphisExec } from '../mcp/tools/exec.js';
import { runMemphisFsOps } from '../mcp/tools/fs-ops.js';
import { runMemphisFsWrite } from '../mcp/tools/fs-write.js';
import { runMemphisGit } from '../mcp/tools/git.js';
import { runMemphisGlob } from '../mcp/tools/glob.js';
import { runMemphisGrep } from '../mcp/tools/grep.js';
import { runMemphisHealthCheck } from '../mcp/tools/health-check.js';
import { runMemphisHealth } from '../mcp/tools/health.js';
import { runMemphisJournal } from '../mcp/tools/journal.js';
import { runMemphisKartograf } from '../mcp/tools/kartograf.js';
import { runMemphisLoopStep } from '../mcp/tools/loop-step.js';
import { runMemphisMediaIngest } from '../mcp/tools/media-ingest.js';
import { runMemphisPackage } from '../mcp/tools/package.js';
import { runMemphisPresence } from '../mcp/tools/presence.js';
import { runMemphisProviders } from '../mcp/tools/providers.js';
import { runMemphisRecall } from '../mcp/tools/recall.js';
import { runMemphisRepair } from '../mcp/tools/repair.js';
import { runMemphisRestart } from '../mcp/tools/restart.js';
import { runMemphisSearch } from '../mcp/tools/search.js';
import { runMemphisSelfDeployVerify } from '../mcp/tools/self-deploy-verify.js';
import { runMemphisSelfDescribe } from '../mcp/tools/self-describe.js';
import { runMemphisSelfModify } from '../mcp/tools/self-modify.js';
import {
  runMemphisSelfPlanAdvance,
  runMemphisSelfPlanCancel,
  runMemphisSelfPlanCreate,
  runMemphisSelfPlanGet,
} from '../mcp/tools/self-plan.js';
import { runMemphisSelfPrOpen } from '../mcp/tools/self-pr-open.js';
import { runMemphisSelfReview } from '../mcp/tools/self-review.js';
import {
  runMemphisSkillCreate,
  runMemphisSkillInstall,
  runMemphisSkillList,
  runMemphisSkillShow,
  runMemphisSkillValidate,
} from '../mcp/tools/skill.js';
import { runMemphisSloStatus } from '../mcp/tools/slo-status.js';
import { runMemphisSoulRead, runMemphisSoulWrite } from '../mcp/tools/soul.js';
import { runMemphisSystemInfo } from '../mcp/tools/system-info.js';
import { runMemphisTest } from '../mcp/tools/test-run.js';
import { runMemphisWebFetch } from '../mcp/tools/web-fetch.js';
import { runMemphisWebSearch } from '../mcp/tools/web-search.js';
import type { ChatToolCall, ChatToolDefinition } from '../providers/index.js';
import { loadSoulManifest } from '../soul/manifest.js';
import { updateSoulMemory } from '../soul/memory.js';
import { soulMemoryUpdateSchema, type SoulManifest } from '../soul/types.js';

export type InProcessToolExecutorDeps = {
  evolveSessionRepository?: SqliteEvolveSessionRepository;
  permissionRepo?: SqliteToolPermissionRepository;
  caseAdapter?: CaseChainAdapter;
  rollback?: RollbackManager;
  projectRoot?: string;
  hooks?: ToolExecutionHook[];
  abortSignal?: AbortSignal;
  rawEnv?: NodeJS.ProcessEnv;
  surface?: string;
  auditSurface?: string;
  maxParallel?: number;
  /**
   * Conversation / session identifiers for tool-originated writes
   * (e.g. `memphis_journal` called by the model). Plumbed through to
   * `runMemphisJournal` so the trajectory exporter groups
   * tool-emitted memories under the same session as the in-process
   * memory-client writes (N8.2). Set by turn-runtime when the
   * executor is constructed per-turn.
   */
  conversationId?: string;
  sessionId?: string;
  turnId?: string;
};

function defaultManifest(): SoulManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    generatedAt: now,
    identity: {
      agentName: 'Memphis',
      ownerName: 'operator',
      runtimeMode: 'local',
      createdAt: now,
    },
    capabilities: {
      tools: [],
      chains: [],
      channels: [],
      providers: [],
      rustBridge: false,
    },
    boundaries: {
      tier0: { auth: 'none', scope: 'local' },
      tier1: { auth: 'token', scope: 'local' },
      tier2: { auth: 'passphrase', scope: 'sensitive' },
    },
    evolution: {
      autoApproveReflections: false,
      requirePassphraseForTier2: true,
      snapshotBeforeEvolution: true,
    },
    mode: 'balanced',
    trustRules: [],
  };
}

type ToolInput = Record<string, unknown>;
type SoulReadSection = 'user' | 'self' | 'context' | 'all';

function requiredString(args: ToolInput, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', `tool ${key} must be a non-empty string`, 400);
  }
  return value;
}

function optionalString(args: ToolInput, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function optionalStringArray(args: ToolInput, key: string): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  );
  return strings.length > 0 ? strings : undefined;
}

function optionalNumber(args: ToolInput, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(args: ToolInput, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

function requiredRecord(args: ToolInput, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('VALIDATION_ERROR', `tool ${key} must be an object`, 400);
  }
  return value as Record<string, unknown>;
}

function optionalSoulReadSection(args: ToolInput, key: string): SoulReadSection | undefined {
  const value = args[key];
  return value === 'user' || value === 'self' || value === 'context' || value === 'all'
    ? value
    : undefined;
}

function createRuntimeTools(deps: InProcessToolExecutorDeps): RuntimeToolDefinition[] {
  const tools: RuntimeToolDefinition[] = [
    buildTool({
      name: 'memphis_journal',
      description:
        'Save important context or observations to the journal chain for later recall. This is NOT a channel for replying to the user — always produce a normal text reply after any tool calls.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Content to journal' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        },
        required: ['content'],
      },
      isReadOnly: false,
      isDestructive: false,
      validateInput(args) {
        return {
          content: requiredString(args, 'content'),
          tags: optionalStringArray(args, 'tags'),
        };
      },
      async execute(input) {
        // Thread caller surface + conversation binding into the
        // journal write so consent resolution honors the active turn's
        // surface policy (MEMPHIS_SURFACE_<SURFACE>_DEFAULT_CONSENT
        // overrides apply) AND the trajectory exporter groups
        // tool-emitted writes under the same session as memory-client
        // writes. Falls through to 'mcp' default and no binding when
        // the executor was constructed without the turn context (raw
        // MCP server case).
        return runMemphisJournal({
          ...input,
          surface: deps.surface,
          conversationId: deps.conversationId,
          sessionId: deps.sessionId,
          turnId: deps.turnId,
        });
      },
    }),
    buildTool({
      name: 'memphis_kartograf',
      description:
        'Run Kartograf inference on text — returns 256-d embedding + zone classification (12 chains). Requires installed checkpoint + MEMPHIS_KARTOGRAF_ENABLE=1. Returns structured error if either is missing.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to classify (1-8192 chars)' },
          top_k_zones: {
            type: 'number',
            description: 'Return only top-K zones (1-12). Omit for full distribution.',
          },
        },
        required: ['query'],
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        const q = (args as { query?: unknown }).query;
        if (typeof q !== 'string' || q.length === 0) {
          throw new Error('memphis_kartograf: query (string, 1-8192 chars) is required');
        }
        if (q.length > 8192) {
          throw new Error('memphis_kartograf: query exceeds 8192-char limit');
        }
        const topKRaw = (args as { top_k_zones?: unknown }).top_k_zones;
        const top_k_zones =
          typeof topKRaw === 'number' && Number.isFinite(topKRaw) && topKRaw >= 1 && topKRaw <= 12
            ? Math.floor(topKRaw)
            : undefined;
        return { query: q, ...(top_k_zones !== undefined ? { top_k_zones } : {}) };
      },
      execute(input) {
        return runMemphisKartograf(input, deps.rawEnv);
      },
    }),
    buildTool({
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
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          query: requiredString(args, 'query'),
          limit: optionalNumber(args, 'limit') ?? 5,
        };
      },
      execute(input) {
        return runMemphisRecall(input);
      },
    }),
    buildTool({
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
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          query: requiredString(args, 'query'),
          limit: optionalNumber(args, 'limit') ?? 5,
          chain: optionalString(args, 'chain'),
        };
      },
      execute(input) {
        return runMemphisSearch(input);
      },
    }),
    buildTool({
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
      validateInput(args) {
        return {
          title: requiredString(args, 'title'),
          choice: requiredString(args, 'choice'),
          context: optionalString(args, 'context'),
        };
      },
      async execute(input) {
        return runMemphisDecide(input);
      },
    }),
    buildTool({
      name: 'memphis_health',
      description: 'Check Memphis runtime health',
      inputSchema: { type: 'object', properties: {} },
      isConcurrencySafe: true,
      isReadOnly: true,
      execute() {
        return runMemphisHealth();
      },
    }),
    buildTool({
      name: 'memphis_slo_status',
      description:
        'Runtime SLO snapshot — reads telemetry spans over a time window (default 7 days) and reports each SLO as pass/fail/unavailable',
      inputSchema: {
        type: 'object',
        properties: {
          windowDays: {
            type: 'number',
            description: 'Number of days to scan back (1-90, default 7)',
          },
        },
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      execute(args: { windowDays?: number }) {
        return runMemphisSloStatus({ windowDays: args.windowDays }, deps.rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_repair',
      description:
        'Repair Memphis runtime state — chain integrity, SQLite migrations, derived indexes',
      inputSchema: {
        type: 'object',
        properties: {
          force: {
            type: 'boolean',
            description: 'Force repair even when manual intervention is recommended',
          },
        },
      },
      isConcurrencySafe: false,
      isReadOnly: false,
      validateInput(args) {
        return {
          force: typeof args.force === 'boolean' ? args.force : false,
        };
      },
      async execute(input) {
        return runMemphisRepair({ force: input.force });
      },
    }),
    buildTool({
      name: 'memphis_soul_read',
      description: 'Read soul memory and persistent identity',
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: ['user', 'self', 'context', 'all'] },
        },
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          section: optionalSoulReadSection(args, 'section'),
        };
      },
      async execute(input) {
        return runMemphisSoulRead(input);
      },
    }),
    buildTool({
      name: 'memphis_soul_write',
      description: 'Update soul memory and persistent preferences',
      inputSchema: {
        type: 'object',
        properties: {
          updates: { type: 'object', description: 'Soul memory update payload' },
        },
        required: ['updates'],
      },
      validateInput(args) {
        // Mode B (LLM-direct via gateway tool-executor) bypasses the MCP
        // Zod gate, so prior to this guard a model could send
        // `{ updates: { user: { languages: "Polish" } } }` (string instead
        // of array) or `{ updates: { context: { weirdKey: ... } } }`
        // (extra keys), and updateSoulMemory would either silently drop
        // the bogus fields (operator sees `memory: null` on the next read)
        // or crash with "additions is not iterable" when dedupeAppend
        // tried to spread a non-iterable.
        //
        // We mirror the MCP server schema (server.ts:989) here so both
        // surfaces reject the same shapes the same way.
        const updatesRaw = requiredRecord(args, 'updates');
        const parsed = soulMemoryUpdateSchema.safeParse(updatesRaw);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const path = issue?.path?.join('.') ?? '<root>';
          // 2026-05-12 (P1 of memphis-skill-tools-and-schema-hints):
          // include a concrete CORRECT-SHAPE sample in the error so the
          // LLM can self-correct in one retry instead of flipping array
          // <-> string repeatedly (observed pattern 2026-05-11 23:27).
          throw new AppError(
            'VALIDATION_ERROR',
            `tool memphis_soul_write: invalid \`updates.${path}\`: ${issue?.message ?? 'shape mismatch'}.\n` +
              `Correct shape (string fields use a single string; list fields use array of strings):\n` +
              `{\n` +
              `  "updates": {\n` +
              `    "user":    { "name": "Marcin", "languages": ["pl","en"], "preferences": ["concise"] },\n` +
              `    "self":    { "personality": "direct + audit-trail", "strengths": ["focus"], "learnings": ["read schema first"] },\n` +
              `    "context": { "activeWork": "skill scaffold tooling", "recentDecisions": ["bundle P0+P1 in one PR"] }\n` +
              `  }\n` +
              `}\n` +
              `String-shape fields: user.name, self.personality, context.activeWork.\n` +
              `Array-of-string fields: user.languages, user.preferences, user.expertise, user.integrations, self.strengths, self.learnings, self.evolvedCapabilities, context.recentDecisions.\n` +
              `Unknown keys are rejected (strict schema).`,
            400,
          );
        }
        return { updates: parsed.data };
      },
      async execute(input) {
        return runMemphisSoulWrite(
          input,
          deps.caseAdapter
            ? {
                update: updateSoulMemory,
                caseAdapter: deps.caseAdapter,
              }
            : undefined,
        );
      },
    }),
    buildTool({
      name: 'memphis_case_append',
      description: 'Append an entry to the case chain',
      inputSchema: {
        type: 'object',
        properties: {
          entry: { type: 'object', description: 'Case chain entry payload' },
        },
        required: ['entry'],
      },
      validateInput(args) {
        return { entry: requiredRecord(args, 'entry') as never };
      },
      async execute(input) {
        return runMemphisCaseAppend(
          input,
          deps.caseAdapter ? { adapter: deps.caseAdapter } : undefined,
        );
      },
    }),
    buildTool({
      name: 'memphis_case_query',
      description: 'Query the case chain index',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'object', description: 'Case chain query payload' },
        },
        required: ['query'],
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return { query: requiredRecord(args, 'query') as never };
      },
      async execute(input) {
        return runMemphisCaseQuery(
          input,
          deps.caseAdapter ? { adapter: deps.caseAdapter } : undefined,
        );
      },
    }),
    buildTool({
      name: 'memphis_chain_query',
      description: 'Query raw chain blocks with optional filters',
      inputSchema: {
        type: 'object',
        properties: {
          chain: { type: 'string', description: 'Chain name to query' },
          limit: { type: 'number', description: 'Max number of blocks to return' },
          offset: { type: 'number', description: 'Starting offset into the result set' },
          blockType: { type: 'string', description: 'Optional block type filter' },
          contains: { type: 'string', description: 'Optional substring filter' },
          tag: { type: 'string', description: 'Optional tag filter' },
        },
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          chain: optionalString(args, 'chain'),
          limit: optionalNumber(args, 'limit'),
          offset: optionalNumber(args, 'offset'),
          blockType: optionalString(args, 'blockType'),
          contains: optionalString(args, 'contains'),
          tag: optionalString(args, 'tag'),
        };
      },
      execute(input) {
        return runMemphisChainQuery(input);
      },
    }),
    buildTool({
      name: 'memphis_providers',
      description: 'Inspect configured providers and available models',
      inputSchema: { type: 'object', properties: {} },
      isConcurrencySafe: true,
      isReadOnly: true,
      async execute() {
        return runMemphisProviders();
      },
    }),
    buildTool({
      name: 'memphis_system_info',
      description: 'Inspect host and Memphis runtime system information',
      inputSchema: { type: 'object', properties: {} },
      isConcurrencySafe: true,
      isReadOnly: true,
      execute() {
        return runMemphisSystemInfo();
      },
    }),
    buildTool({
      name: 'memphis_web_fetch',
      description: 'Fetch a public URL',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL to fetch' } },
        required: ['url'],
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return { url: requiredString(args, 'url') };
      },
      async execute(input) {
        return runMemphisWebFetch(input);
      },
    }),
    buildTool({
      name: 'memphis_code_read',
      description: 'Read files inside ~/memphis/ (whitelisted, read-only)',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or ~-relative path inside ~/memphis/' },
          startLine: { type: 'number', description: 'Start line (1-indexed, inclusive)' },
          endLine: { type: 'number', description: 'End line (1-indexed, inclusive)' },
          limit: { type: 'number', description: 'Max lines to return (default 2000, max 2000)' },
        },
        required: ['path'],
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          path: requiredString(args, 'path'),
          startLine: optionalNumber(args, 'startLine'),
          endLine: optionalNumber(args, 'endLine'),
          limit: optionalNumber(args, 'limit'),
        };
      },
      execute(input) {
        return runMemphisCodeRead(input);
      },
    }),
    buildTool({
      name: 'memphis_grep',
      description: 'Search code using regex patterns (ripgrep or grep)',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: {
            type: 'string',
            description: 'Subdirectory to search within (relative to project root)',
          },
          glob: { type: 'string', description: 'Glob to filter files (e.g. "*.ts", "*.rs")' },
          limit: { type: 'number', description: 'Max results (default 50, max 200)' },
          context: { type: 'number', description: 'Lines of context around matches (max 10)' },
          ignoreCase: { type: 'boolean', description: 'Case-insensitive search' },
        },
        required: ['pattern'],
      },
      isReadOnly: true,
      isDestructive: false,
      validateInput(args) {
        return {
          pattern: requiredString(args, 'pattern'),
          path: optionalString(args, 'path'),
          glob: optionalString(args, 'glob'),
          limit: optionalNumber(args, 'limit'),
          context: optionalNumber(args, 'context'),
          ignoreCase: args.ignoreCase === true,
        };
      },
      execute(input) {
        return runMemphisGrep(input);
      },
    }),
    buildTool({
      name: 'memphis_glob',
      description: 'Find files by glob pattern (fd or find)',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "*.json")' },
          path: {
            type: 'string',
            description: 'Subdirectory to search within (relative to project root)',
          },
          limit: { type: 'number', description: 'Max results (default 100, max 500)' },
        },
        required: ['pattern'],
      },
      isReadOnly: true,
      isDestructive: false,
      validateInput(args) {
        return {
          pattern: requiredString(args, 'pattern'),
          path: optionalString(args, 'path'),
          limit: optionalNumber(args, 'limit'),
        };
      },
      execute(input) {
        return runMemphisGlob(input);
      },
    }),
    buildTool({
      name: 'memphis_git',
      description:
        'Git operations — status, log, diff, add, commit, push (read ops: tier 1, write ops: tier 2)',
      inputSchema: {
        type: 'object',
        properties: {
          subcommand: {
            type: 'string',
            description: 'Git subcommand (status, log, diff, add, commit, push, etc.)',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Arguments for the subcommand',
          },
        },
        required: ['subcommand'],
      },
      isReadOnly: false,
      isDestructive: false,
      validateInput(args) {
        return {
          subcommand: requiredString(args, 'subcommand'),
          args: optionalStringArray(args, 'args'),
        };
      },
      execute(input) {
        return runMemphisGit(input);
      },
    }),
    buildTool({
      name: 'memphis_test',
      description: 'Run project tests (ts, rust, lint, typecheck, or all)',
      inputSchema: {
        type: 'object',
        properties: {
          suite: {
            type: 'string',
            description: 'Test suite: "ts" | "rust" | "lint" | "typecheck" | "all" (default: ts)',
          },
          filter: { type: 'string', description: 'Filter pattern for test files (vitest only)' },
        },
      },
      isReadOnly: false,
      isDestructive: false,
      validateInput(args) {
        return {
          suite: optionalString(args, 'suite'),
          filter: optionalString(args, 'filter'),
        };
      },
      execute(input) {
        return runMemphisTest(input);
      },
    }),
    buildTool({
      name: 'memphis_deploy',
      description: 'Run deploy, health, and rollback workflows with snapshots and health checks',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action: run | health | rollback' },
          profile: {
            type: 'string',
            description: 'Deploy profile: local-service | build-only | custom',
          },
          buildCommand: { type: 'string', description: 'Build command override' },
          deployCommand: { type: 'string', description: 'Custom deploy command override' },
          healthUrl: { type: 'string', description: 'HTTP health endpoint override' },
          testSuite: {
            type: 'string',
            description: 'Test suite: ts | rust | lint | typecheck | all',
          },
          deep: { type: 'boolean', description: 'Run deeper doctor checks' },
          dryRun: {
            type: 'boolean',
            description: 'Preview the deploy plan without mutating state',
          },
          rollbackIndex: {
            type: 'number',
            description: 'Snapshot index for rollback (1 = latest)',
          },
        },
      },
      isReadOnly: false,
      isDestructive: true,
      validateInput(args) {
        return {
          action: optionalString(args, 'action') as 'run' | 'health' | 'rollback' | undefined,
          profile: optionalString(args, 'profile') as
            | 'local-service'
            | 'build-only'
            | 'custom'
            | undefined,
          buildCommand: optionalString(args, 'buildCommand'),
          deployCommand: optionalString(args, 'deployCommand'),
          healthUrl: optionalString(args, 'healthUrl'),
          testSuite: optionalString(args, 'testSuite') as
            | 'ts'
            | 'rust'
            | 'lint'
            | 'typecheck'
            | 'all'
            | undefined,
          deep: args.deep === true,
          dryRun: args.dryRun === true,
          rollbackIndex: optionalNumber(args, 'rollbackIndex'),
        };
      },
      async execute(input) {
        return runMemphisDeploy(input);
      },
    }),
    buildTool({
      name: 'memphis_cron',
      description: 'Manage scheduled tasks — list, add, remove, enable, disable cron jobs',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action: list | add | remove | enable | disable' },
          cron: {
            type: 'string',
            description: 'Cron expression (for add, e.g. "0 * * * *" = hourly)',
          },
          name: { type: 'string', description: 'Task name (for add)' },
          taskType: {
            type: 'string',
            description: 'Task type: shell | reflection | git-pull-build | http',
          },
          script: { type: 'string', description: 'Shell script (for shell type)' },
          url: { type: 'string', description: 'URL (for http type)' },
          method: { type: 'string', description: 'HTTP method (for http type, default GET)' },
          taskId: { type: 'string', description: 'Task ID (for remove/enable/disable)' },
        },
        required: ['action'],
      },
      isReadOnly: false,
      isDestructive: true,
      validateInput(args) {
        return {
          action: requiredString(args, 'action') as
            | 'list'
            | 'add'
            | 'remove'
            | 'enable'
            | 'disable',
          cron: optionalString(args, 'cron'),
          name: optionalString(args, 'name'),
          taskType: optionalString(args, 'taskType') as
            | 'shell'
            | 'reflection'
            | 'git-pull-build'
            | 'http'
            | undefined,
          script: optionalString(args, 'script'),
          url: optionalString(args, 'url'),
          method: optionalString(args, 'method'),
          taskId: optionalString(args, 'taskId'),
        };
      },
      execute(input) {
        return runMemphisCron(input);
      },
    }),
    buildTool({
      name: 'memphis_exec',
      description: 'Execute a shell command',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Command to execute' } },
        required: ['command'],
      },
      isDestructive: true,
      validateInput(args) {
        return { command: requiredString(args, 'command') };
      },
      execute(input) {
        try {
          return runMemphisExec(input, deps.rawEnv);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
    buildTool({
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
      isDestructive: true,
      validateInput(args) {
        return {
          intent: requiredString(args, 'intent'),
          files: optionalStringArray(args, 'files') ?? [],
          changes: requiredRecord(args, 'changes') as Record<string, string>,
          passphrase: optionalString(args, 'passphrase'),
        };
      },
      async execute(input) {
        if (!deps.evolveSessionRepository) {
          return {
            error: 'memphis_self_modify requires evolve session repository in this runtime surface',
          };
        }
        return runMemphisSelfModify(input, {
          sessionRepo: deps.evolveSessionRepository,
          rollback: deps.rollback ?? new RollbackManager(getDataDir()),
          caseAdapter: deps.caseAdapter ?? new CaseChainAdapter(),
          projectRoot: deps.projectRoot,
          rawEnv: deps.rawEnv,
        });
      },
    }),

    // ── Foundation tools ────────────────────────────────────────────

    buildTool({
      name: 'memphis_fs_write',
      description:
        'Write/append/overwrite files. Inside ~/memphis/: unrestricted. ' +
        'Outside: create-new is always allowed; append and overwrite require tier 3.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Content to write' },
          mode: { type: 'string', enum: ['write', 'append', 'overwrite'] },
          createDirs: { type: 'boolean' },
        },
        required: ['path', 'content'],
      },
      isDestructive: true,
      validateInput(args) {
        return {
          path: requiredString(args, 'path'),
          content: requiredString(args, 'content'),
          mode: optionalString(args, 'mode') as 'write' | 'append' | 'overwrite' | undefined,
          createDirs: optionalBoolean(args, 'createDirs'),
        };
      },
      execute(input) {
        return runMemphisFsWrite(input, deps.rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_fs_ops',
      description: 'Filesystem operations: copy, move, delete, mkdir, stat',
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['copy', 'move', 'delete', 'mkdir', 'stat'] },
          source: { type: 'string' },
          destination: { type: 'string' },
          recursive: { type: 'boolean' },
        },
        required: ['operation', 'source'],
      },
      isDestructive: true,
      validateInput(args) {
        return {
          operation: requiredString(args, 'operation') as
            | 'copy'
            | 'move'
            | 'delete'
            | 'mkdir'
            | 'stat',
          source: requiredString(args, 'source'),
          destination: optionalString(args, 'destination'),
          recursive: optionalBoolean(args, 'recursive'),
        };
      },
      execute(input) {
        return runMemphisFsOps(input, deps.rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_web_search',
      description: 'Search the web via DuckDuckGo',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results (1-10)' },
        },
        required: ['query'],
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      validateInput(args) {
        return {
          query: requiredString(args, 'query'),
          limit: optionalNumber(args, 'limit'),
        };
      },
      async execute(input) {
        return runMemphisWebSearch(input);
      },
    }),
    buildTool({
      name: 'memphis_brave_search',
      description: 'Search the web via Brave Search API',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results (1-20)' },
          country: { type: 'string', description: 'ISO 3166-1 alpha-2 country code' },
          search_lang: { type: 'string', description: 'ISO 639-1 language code' },
        },
        required: ['query'],
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      validateInput(args) {
        return {
          query: requiredString(args, 'query'),
          limit: optionalNumber(args, 'limit'),
          country: optionalString(args, 'country'),
          search_lang: optionalString(args, 'search_lang'),
        };
      },
      async execute(input) {
        return runMemphisBraveSearch(input, deps.rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_media_ingest',
      description: 'Ingest a media file (audio/image) — transcribe + describe + write to chains',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to media file' },
          type: {
            type: 'string',
            enum: ['audio', 'image', 'video', 'auto'],
            description: 'Override auto-detection',
          },
          dryRun: { type: 'boolean', description: 'Skip chain writes' },
        },
        required: ['path'],
      },
      isReadOnly: false,
      isConcurrencySafe: false,
      validateInput(args) {
        return {
          path: requiredString(args, 'path'),
          type: optionalString(args, 'type') as
            | 'audio'
            | 'image'
            | 'video'
            | 'auto'
            | undefined,
          dryRun: optionalBoolean(args, 'dryRun'),
        };
      },
      async execute(input) {
        return runMemphisMediaIngest(input, deps.rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_package',
      description: 'Package manager operations (npm, cargo, apt, pip)',
      inputSchema: {
        type: 'object',
        properties: {
          manager: { type: 'string', enum: ['npm', 'cargo', 'apt', 'pip'] },
          action: { type: 'string', enum: ['install', 'remove', 'list', 'search'] },
          packages: { type: 'array', items: { type: 'string' } },
          global: { type: 'boolean' },
        },
        required: ['manager', 'action'],
      },
      isDestructive: true,
      validateInput(args) {
        return {
          manager: requiredString(args, 'manager') as 'npm' | 'cargo' | 'apt' | 'pip',
          action: requiredString(args, 'action') as 'install' | 'remove' | 'list' | 'search',
          packages: optionalStringArray(args, 'packages'),
          global: optionalBoolean(args, 'global'),
        };
      },
      execute(input) {
        return runMemphisPackage(input);
      },
    }),
    buildTool({
      name: 'memphis_db',
      description: 'Query and manage SQLite databases',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['query', 'execute', 'tables', 'schema'] },
          sql: { type: 'string' },
          database: { type: 'string' },
        },
        required: ['action'],
      },
      validateInput(args) {
        return {
          action: requiredString(args, 'action') as 'query' | 'execute' | 'tables' | 'schema',
          sql: optionalString(args, 'sql'),
          database: optionalString(args, 'database'),
        };
      },
      execute(input) {
        return runMemphisDb(input);
      },
    }),

    // ── Build/deploy tools ──────────────────────────────────────────

    buildTool({
      name: 'memphis_build',
      description: 'Auto-detect project type and run build',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Subdirectory to build' },
          command: { type: 'string', description: 'Override build command' },
          profile: { type: 'string', enum: ['debug', 'release'] },
        },
      },
      isDestructive: false,
      validateInput(args) {
        return {
          project: optionalString(args, 'project'),
          command: optionalString(args, 'command'),
          profile: optionalString(args, 'profile') as 'debug' | 'release' | undefined,
        };
      },
      execute(input) {
        return runMemphisBuild(input);
      },
    }),
    buildTool({
      name: 'memphis_health_check',
      description: 'HTTP health checks against targets',
      inputSchema: {
        type: 'object',
        properties: {
          targets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                timeout: { type: 'number' },
                expectedStatus: { type: 'number' },
              },
              required: ['url'],
            },
          },
        },
        required: ['targets'],
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      validateInput(args) {
        const targets = args.targets;
        if (!Array.isArray(targets)) {
          throw new AppError('VALIDATION_ERROR', 'targets must be an array', 400);
        }
        return {
          targets: targets as Array<{ url: string; timeout?: number; expectedStatus?: number }>,
        };
      },
      async execute(input) {
        return runMemphisHealthCheck(input);
      },
    }),
    // ─────────────────────────────────────────────────────────────────
    // S1 (sprint 2026-04-26): wire 7 tools that lived only as MCP tools.
    // Each thin-wraps the existing `runMemphis*` function from src/mcp/tools/.
    // The runtime path (TUI / Telegram / chat / CLI) now sees them too.
    //
    // Design note: keep these as JSON.stringify(returnValue) — the runtime
    // contract for `execute(input): Promise<string>` requires a string, and
    // the MCP helpers return structured objects.
    // ─────────────────────────────────────────────────────────────────
    buildTool({
      name: 'memphis_config_show',
      description: 'Show current runtime config (redacted view of hot-reloadable env)',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Optional single config key to inspect' },
        },
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      validateInput(args) {
        return { key: optionalString(args, 'key') };
      },
      async execute(input) {
        return runMemphisConfigShow(input);
      },
    }),
    buildTool({
      name: 'memphis_config_set',
      description:
        'Set a single config key/value. Cold fields refuse; secret fields require operator passphrase.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Config key (must be in known-fields whitelist)' },
          value: { type: 'string', description: 'New value' },
          passphrase: { type: 'string', description: 'Operator passphrase if key is secret' },
        },
        required: ['key', 'value'],
      },
      isReadOnly: false,
      validateInput(args) {
        const value = args.value;
        if (typeof value !== 'string') {
          throw new AppError('VALIDATION_ERROR', 'tool value must be a string', 400);
        }
        return {
          key: requiredString(args, 'key'),
          // empty string is intentionally allowed — the LLM uses
          // `memphis_config_set { key: 'X', value: '' }` to clear a
          // mutable config field. requiredString rejected those; field
          // validation lives in runMemphisConfigSet itself.
          value,
          passphrase: optionalString(args, 'passphrase'),
        };
      },
      async execute(input) {
        return runMemphisConfigSet(input);
      },
    }),
    buildTool({
      name: 'memphis_config_reload',
      description: 'Re-read .env and hot-swap mutable fields (cold fields refuse — restart needed)',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      isReadOnly: false,
      validateInput() {
        return {};
      },
      async execute() {
        return runMemphisConfigReload();
      },
    }),
    buildTool({
      name: 'memphis_cognitive_mode_set',
      description:
        'Switch cognitive mode (A–E: ConsciousCapture / InferredDecisions / PredictivePatterns / CollectiveCoord / MetaCognitiveRef). Requires operator passphrase.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', description: 'Target mode: A | B | C | D | E' },
          passphrase: { type: 'string', description: 'Operator passphrase' },
        },
        required: ['mode'],
      },
      isReadOnly: false,
      validateInput(args) {
        return {
          mode: requiredString(args, 'mode'),
          passphrase: optionalString(args, 'passphrase'),
        };
      },
      async execute(input) {
        return runMemphisCognitiveModeSet(input);
      },
    }),
    buildTool({
      name: 'memphis_presence',
      description: 'Cross-surface presence snapshot (TUI / Telegram / HTTP / CLI activity)',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      validateInput() {
        return {};
      },
      async execute() {
        return runMemphisPresence();
      },
    }),
    buildTool({
      name: 'memphis_loop_step',
      description:
        'Cognitive loop enforcement step (Rust LoopEngine via NAPI, TS fallback if bridge unavailable)',
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'object', description: 'Current loop state' },
          action: { type: 'object', description: 'Proposed action' },
          limits: { type: 'object', description: 'Optional override limits' },
        },
        required: ['state', 'action'],
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      validateInput(args) {
        return {
          state: requiredRecord(args, 'state'),
          action: requiredRecord(args, 'action'),
          limits: args.limits as Record<string, unknown> | undefined,
        };
      },
      async execute(input) {
        return runMemphisLoopStep(
          input as unknown as Parameters<typeof runMemphisLoopStep>[0],
        );
      },
    }),
    buildTool({
      name: 'memphis_restart',
      description:
        'Request a self-restart of the Memphis daemon. Requires operator passphrase (no per-surface tier-3 session is minted via tools).',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Reason for the restart (audited)' },
          actor_id: { type: 'string', description: 'Actor identifier (audit context)' },
          passphrase: { type: 'string', description: 'Operator passphrase' },
        },
      },
      isReadOnly: false,
      isDestructive: true,
      validateInput(args) {
        return {
          reason: optionalString(args, 'reason'),
          actor_id: optionalString(args, 'actor_id'),
          passphrase: optionalString(args, 'passphrase'),
        };
      },
      async execute(input) {
        return runMemphisRestart(input);
      },
    }),
    buildTool({
      name: 'memphis_self_describe',
      description:
        'Runtime self-introspection — returns active surface policy, effective tier (with tier-3 session info), cognitive mode, full tool inventory with availability, feature flags, and cross-surface tier-3 sessions. Use this BEFORE answering "what can you do" — never hallucinate capabilities from training data.',
      inputSchema: {
        type: 'object',
        properties: {
          surface: { type: 'string', description: 'Override active surface name' },
          actorId: { type: 'string', description: 'Actor id for tier-3 lookup' },
        },
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      validateInput(args) {
        return {
          surface: optionalString(args, 'surface'),
          actorId: optionalString(args, 'actorId'),
        };
      },
      async execute(input) {
        const surface = input.surface ?? deps.surface ?? 'mcp';
        return runMemphisSelfDescribe({ ...input, surface }, deps.rawEnv);
      },
    }),
    // ─── S5 self-coding plan/execute/review/PR/verify (PR #593) ──────────
    // The plan tools are data-layer (read/write tier-0 JSON state).
    // Wired into the in-process executor so an agent loop can call them
    // directly without re-entering the MCP layer.
    buildTool({
      name: 'memphis_self_plan_create',
      description:
        'Open a durable multi-step self-coding plan. Returns plan_id for use with memphis_self_plan_{get,advance,cancel} and the step-aware mode of memphis_self_modify.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Operator-facing one-line goal.' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: { description: { type: 'string' } },
              required: ['description'],
            },
            description: 'Ordered list of steps, each {description}.',
          },
        },
        required: ['goal', 'steps'],
      },
      isConcurrencySafe: false,
      isReadOnly: false,
      validateInput(args) {
        const goal = requiredString(args, 'goal');
        const rawSteps = (args as { steps?: unknown }).steps;
        if (!Array.isArray(rawSteps)) {
          throw new AppError('VALIDATION_ERROR', 'steps must be an array', 400);
        }
        const steps = rawSteps.map((s, i) => {
          if (!s || typeof s !== 'object') {
            throw new AppError('VALIDATION_ERROR', `steps[${i}] must be an object`, 400);
          }
          const description = (s as { description?: unknown }).description;
          if (typeof description !== 'string' || description.trim().length === 0) {
            throw new AppError(
              'VALIDATION_ERROR',
              `steps[${i}].description is required`,
              400,
            );
          }
          return { description };
        });
        return { goal, steps };
      },
      execute(input) {
        return runMemphisSelfPlanCreate(input, deps.rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_self_plan_get',
      description:
        'Read a self-coding plan by id. Returns {plan, next_step}; next_step surfaces the first pending or failed step (failed first, so retries resume before new work).',
      inputSchema: {
        type: 'object',
        properties: { plan_id: { type: 'string' } },
        required: ['plan_id'],
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return { plan_id: requiredString(args, 'plan_id') };
      },
      execute(input) {
        return runMemphisSelfPlanGet(input, deps.rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_self_plan_advance',
      description:
        'Mark a plan step as in_progress/done/failed/skipped/pending. attempts auto-increments on in_progress/failed. Passing artifact clears lastError on the step.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_id: { type: 'string' },
          step_idx: { type: 'number' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'done', 'failed', 'skipped'],
          },
          artifact: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['plan_id', 'step_idx', 'status'],
      },
      isConcurrencySafe: false,
      isReadOnly: false,
      validateInput(args) {
        const status = requiredString(args, 'status') as
          | 'pending'
          | 'in_progress'
          | 'done'
          | 'failed'
          | 'skipped';
        const stepIdxRaw = (args as { step_idx?: unknown }).step_idx;
        if (typeof stepIdxRaw !== 'number' || !Number.isFinite(stepIdxRaw)) {
          throw new AppError('VALIDATION_ERROR', 'step_idx must be a number', 400);
        }
        return {
          plan_id: requiredString(args, 'plan_id'),
          step_idx: stepIdxRaw,
          status,
          artifact: optionalString(args, 'artifact'),
          error: optionalString(args, 'error'),
        };
      },
      execute(input) {
        return runMemphisSelfPlanAdvance(input, deps.rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_self_plan_cancel',
      description:
        'Cancel a self-coding plan with a reason recorded on the first non-terminal step for audit.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['plan_id', 'reason'],
      },
      isConcurrencySafe: false,
      isReadOnly: false,
      validateInput(args) {
        return {
          plan_id: requiredString(args, 'plan_id'),
          reason: requiredString(args, 'reason'),
        };
      },
      execute(input) {
        return runMemphisSelfPlanCancel(input, deps.rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_self_review',
      description:
        'Pre-PR review: gap (step done with no artifact), unfinished steps, scope creep (files not named by any step), TODO/FIXME/XXX/HACK markers added in plan diff. Returns {ok, checklist, blockers[]}.',
      inputSchema: {
        type: 'object',
        properties: { plan_id: { type: 'string' } },
        required: ['plan_id'],
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return { plan_id: requiredString(args, 'plan_id') };
      },
      async execute(input) {
        return runMemphisSelfReview(input, { rawEnv: deps.rawEnv });
      },
    }),
    buildTool({
      name: 'memphis_self_pr_open',
      description:
        'Push the plan branch and open a PR via gh. Auto-derives title from plan.goal and body from step list. Sets plan status pr-open + records prUrl. Memphis NEVER merges — operator-only.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_id: { type: 'string' },
          title: { type: 'string' },
          body_prefix: { type: 'string' },
          branch: { type: 'string' },
          base: { type: 'string' },
        },
        required: ['plan_id'],
      },
      isConcurrencySafe: false,
      isReadOnly: false,
      isDestructive: false,
      validateInput(args) {
        return {
          plan_id: requiredString(args, 'plan_id'),
          title: optionalString(args, 'title'),
          body_prefix: optionalString(args, 'body_prefix'),
          branch: optionalString(args, 'branch'),
          base: optionalString(args, 'base'),
        };
      },
      async execute(input) {
        return runMemphisSelfPrOpen(input, { rawEnv: deps.rawEnv });
      },
    }),
    buildTool({
      name: 'memphis_self_deploy_verify',
      description:
        'C-step: confirm merged PR shipped — three checks (PR merged, merge commit on origin/main, build artifact newer than merge timestamp). Sets plan status `done` on all-green.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_id: { type: 'string' },
          build_artifact_path: { type: 'string' },
          base: { type: 'string' },
        },
        required: ['plan_id'],
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          plan_id: requiredString(args, 'plan_id'),
          build_artifact_path: optionalString(args, 'build_artifact_path'),
          base: optionalString(args, 'base'),
        };
      },
      async execute(input) {
        return runMemphisSelfDeployVerify(input, { rawEnv: deps.rawEnv });
      },
    }),
    // ─── Skill management (2026-05-12) ──────────────────────────────────
    // First-class tools for Memphis-side skill composition / install.
    // Replaces the prior pattern of memphis_fs_write + memphis_exec which
    // gave Memphis no schema feedback when a manifest field was wrong.
    buildTool({
      name: 'memphis_skill_list',
      description:
        'List Memphis skills (built-in + local catalog + installed). Filter by installed/draft.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['all', 'installed', 'draft'],
            description: "'installed' = ready-to-run; 'draft' = catalogued but not installed; 'all' = both",
          },
        },
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        const raw = (args as { filter?: unknown }).filter;
        const filter: 'installed' | 'draft' | 'all' | undefined =
          raw === 'installed' || raw === 'draft' || raw === 'all' ? raw : undefined;
        return { filter };
      },
      execute(input) {
        return runMemphisSkillList(input, deps.rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_skill_show',
      description:
        'Show full skill manifest (description, tools, workflow, prompt hints, examples, notes) for one skill, either by id or by direct file path.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill id from memphis_skill_list' },
          file: { type: 'string', description: 'Path to a manifest.json (overrides id)' },
        },
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          id: optionalString(args, 'id'),
          file: optionalString(args, 'file'),
        };
      },
      execute(input) {
        return runMemphisSkillShow(input, deps.rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_skill_create',
      description:
        'Scaffold a draft skill manifest with placeholder workflow + hints. Writes manifest.json + SKILL.md under ~/.memphis/skills/drafts/<id>/ (or custom --out). Memphis edits the placeholders, then runs memphis_skill_validate, then memphis_skill_install.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill id (kebab-case, e.g. daily-brief)' },
          name: { type: 'string', description: 'Human-readable name (default: derived from id)' },
          description: { type: 'string', description: 'One-line description' },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tools the skill will use (must be valid TOOL_REGISTRY entries)',
          },
          out: { type: 'string', description: 'Custom output directory (default: drafts dir)' },
          force: { type: 'boolean', description: 'Overwrite existing draft if present' },
        },
        required: ['id'],
      },
      isReadOnly: false,
      validateInput(args) {
        return {
          id: requiredString(args, 'id'),
          name: optionalString(args, 'name'),
          description: optionalString(args, 'description'),
          tools: optionalStringArray(args, 'tools'),
          out: optionalString(args, 'out'),
          force: optionalBoolean(args, 'force'),
        };
      },
      execute(input) {
        return runMemphisSkillCreate(input, deps.rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_skill_validate',
      description:
        'Validate a skill manifest before install: schema shape + every declared tool must exist in TOOL_REGISTRY. Returns structured ok/error + suggestedFix hint when applicable. Idempotent, safe to call repeatedly.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill id (validates draft from catalog)' },
          file: { type: 'string', description: 'Path to manifest.json (overrides id)' },
        },
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          id: optionalString(args, 'id'),
          file: optionalString(args, 'file'),
        };
      },
      execute(input) {
        return runMemphisSkillValidate(input, deps.rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_skill_install',
      description:
        'Promote a draft skill to catalog + installed dirs and record in the skills registry. Runs validation first; refuses on schema or unknown-tool errors. After install the skill is visible to cognitive frames and cron triggers.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill id (from drafts or catalog)' },
          file: { type: 'string', description: 'Path to manifest.json (overrides id)' },
          force: { type: 'boolean', description: 'Overwrite existing installed skill if present' },
        },
      },
      isReadOnly: false,
      validateInput(args) {
        return {
          id: optionalString(args, 'id'),
          file: optionalString(args, 'file'),
          force: optionalBoolean(args, 'force'),
        };
      },
      execute(input) {
        return runMemphisSkillInstall(input, deps.rawEnv);
      },
    }),
  ];

  return tools.map((tool) => {
    const upstreamEnabled = tool.isEnabled;
    return {
      ...tool,
      isEnabled: () => upstreamEnabled() && isToolEnabledByFeatureFlag(tool.name, deps.rawEnv),
    };
  });
}

async function executeHooksPreflight(
  hooks: ToolExecutionHook[] | undefined,
  call: ChatToolCall,
  deps: InProcessToolExecutorDeps,
): Promise<void> {
  for (const hook of hooks ?? []) {
    const result = await hook.preToolUse?.({
      call,
      surface: deps.surface,
      auditSurface: deps.auditSurface,
      rawEnv: deps.rawEnv,
    });
    if (result && result.allow === false) {
      throw new AppError(
        'PERMISSION_DENIED',
        result.reason ?? `tool ${call.name} blocked by pre-tool hook`,
        403,
      );
    }
  }
}

async function executeHooksSuccess(
  hooks: ToolExecutionHook[] | undefined,
  call: ChatToolCall,
  deps: InProcessToolExecutorDeps,
  result: string,
): Promise<void> {
  for (const hook of hooks ?? []) {
    await hook.postToolUse?.({
      call,
      result,
      surface: deps.surface,
      auditSurface: deps.auditSurface,
      rawEnv: deps.rawEnv,
    });
  }
}

async function executeHooksFailure(
  hooks: ToolExecutionHook[] | undefined,
  call: ChatToolCall,
  deps: InProcessToolExecutorDeps,
  error: string,
): Promise<void> {
  for (const hook of hooks ?? []) {
    await hook.postToolFailure?.({
      call,
      error,
      surface: deps.surface,
      auditSurface: deps.auditSurface,
      rawEnv: deps.rawEnv,
    });
  }
}

async function executeTool(
  call: ChatToolCall,
  deps: InProcessToolExecutorDeps,
  runtimeTools: Map<string, RuntimeToolDefinition>,
): Promise<string> {
  // Enforce tiered authorization before execution
  // Thread rawEnv from request deps so per-request env overrides
  // (e.g. MEMPHIS_AUTONOMY_MODE=full carried in the HTTP request env
  // bag, distinct from the daemon's process.env) propagate into the
  // manifest read. S5-4: prior call site used the loadSoulManifest
  // default (process.env), which silently dropped per-request env
  // intent and stranded the agent on the disk-mode value. Daemon-mode
  // behavior is identical because deps.rawEnv === process.env there.
  const manifest = loadSoulManifest(deps.rawEnv) ?? defaultManifest();
  const result = resolveToolPolicy({
    toolName: call.name,
    permissionRepo: deps.permissionRepo,
    manifest,
  });
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

  await executeHooksPreflight(deps.hooks, call, deps);

  const tool = runtimeTools.get(call.name);
  if (!tool || !tool.isEnabled()) {
    const missing = JSON.stringify({ error: `unknown tool: ${call.name}` });
    await executeHooksSuccess(deps.hooks, call, deps, missing);
    return missing;
  }

  try {
    const validated = tool.validateInput
      ? tool.validateInput(call.arguments)
      : (call.arguments as never);
    const resultValue = await tool.execute(validated, {
      abortSignal: deps.abortSignal,
      surface: deps.surface,
      auditSurface: deps.auditSurface,
      rawEnv: deps.rawEnv,
    });
    const result = JSON.stringify(resultValue);
    await executeHooksSuccess(deps.hooks, call, deps, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await executeHooksFailure(deps.hooks, call, deps, message);
    throw error;
  }
}

export function createInProcessToolExecutor(deps: InProcessToolExecutorDeps = {}): ToolExecutor {
  const runtimeTools = createRuntimeTools(deps);
  const runtimeToolMap = new Map(runtimeTools.map((tool) => [tool.name, tool]));
  return {
    listTools(): ChatToolDefinition[] {
      return runtimeTools.filter((tool) => tool.isEnabled());
    },
    execute(call: ChatToolCall): Promise<string> {
      return executeTool(call, deps, runtimeToolMap);
    },
    maxParallel: deps.maxParallel ?? 4,
    withBinding(binding) {
      // Tool `execute` closures capture `deps` at construction time
      // (see `createRuntimeTools(deps)` above; each tool reads
      // `deps.conversationId` / `deps.sessionId` at execute time).
      // That means a new binding MUST rebuild the tools — a shallow
      // clone of `deps` alone won't reach the existing closures.
      const merged: InProcessToolExecutorDeps = {
        ...deps,
        conversationId: binding.conversationId ?? deps.conversationId,
        sessionId: binding.sessionId ?? deps.sessionId,
        turnId: binding.turnId ?? deps.turnId,
      };
      return createInProcessToolExecutor(merged);
    },
  };
}
