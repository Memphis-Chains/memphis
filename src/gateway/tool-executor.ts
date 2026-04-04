/**
 * In-process tool executor — calls Memphis MCP tool functions directly,
 * no HTTP, no MCP client. Used when the gateway runs inside Memphis.
 */

import { recordAuthorizationDecision, resolveToolPolicy } from './authorization.js';
import type { ToolExecutor } from './chat-types.js';
import { buildTool, type RuntimeToolDefinition, type ToolExecutionHook } from './tool-runtime.js';
import { RollbackManager } from '../backup/rollback.js';
import { getDataDir } from '../config/paths.js';
import { AppError } from '../core/errors.js';
import { CaseChainAdapter } from '../infra/storage/case-chain-adapter.js';
import type { SqliteEvolveSessionRepository } from '../infra/storage/sqlite/repositories/evolve-session-repository.js';
import type { SqliteToolPermissionRepository } from '../infra/storage/sqlite/repositories/tool-permission-repository.js';
import { runMemphisCaseAppend, runMemphisCaseQuery } from '../mcp/tools/case-entry.js';
import { runMemphisCodeRead } from '../mcp/tools/code-read.js';
import { runMemphisDecide } from '../mcp/tools/decide.js';
import { runMemphisExec } from '../mcp/tools/exec.js';
import { runMemphisGit } from '../mcp/tools/git.js';
import { runMemphisGlob } from '../mcp/tools/glob.js';
import { runMemphisGrep } from '../mcp/tools/grep.js';
import { runMemphisHealth } from '../mcp/tools/health.js';
import { runMemphisJournal } from '../mcp/tools/journal.js';
import { runMemphisRecall } from '../mcp/tools/recall.js';
import { runMemphisRepair } from '../mcp/tools/repair.js';
import { runMemphisSearch } from '../mcp/tools/search.js';
import { runMemphisSelfModify } from '../mcp/tools/self-modify.js';
import { runMemphisSoulRead, runMemphisSoulWrite } from '../mcp/tools/soul.js';
import { runMemphisTest } from '../mcp/tools/test-run.js';
import { runMemphisWebFetch } from '../mcp/tools/web-fetch.js';
import type { ChatToolCall, ChatToolDefinition } from '../providers/index.js';
import { loadSoulManifest } from '../soul/manifest.js';
import { updateSoulMemory } from '../soul/memory.js';
import type { SoulManifest } from '../soul/types.js';

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
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

function optionalNumber(args: ToolInput, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requiredRecord(args: ToolInput, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('VALIDATION_ERROR', `tool ${key} must be an object`, 400);
  }
  return value as Record<string, unknown>;
}

function optionalSoulReadSection(
  args: ToolInput,
  key: string,
): SoulReadSection | undefined {
  const value = args[key];
  return value === 'user' || value === 'self' || value === 'context' || value === 'all'
    ? value
    : undefined;
}

function createRuntimeTools(
  deps: InProcessToolExecutorDeps,
): RuntimeToolDefinition[] {
  return [
    buildTool({
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
      isReadOnly: false,
      isDestructive: false,
      validateInput(args) {
        return {
          content: requiredString(args, 'content'),
          tags: optionalStringArray(args, 'tags'),
        };
      },
      async execute(input) {
        return runMemphisJournal(input);
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
      name: 'memphis_repair',
      description: 'Repair Memphis runtime state — chain integrity, SQLite migrations, derived indexes',
      inputSchema: {
        type: 'object',
        properties: {
          force: { type: 'boolean', description: 'Force repair even when manual intervention is recommended' },
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
        return {
          updates: requiredRecord(args, 'updates'),
        };
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
          path: { type: 'string', description: 'Subdirectory to search within (relative to project root)' },
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
          path: { type: 'string', description: 'Subdirectory to search within (relative to project root)' },
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
      description: 'Git operations — status, log, diff, add, commit, push (read ops: tier 1, write ops: tier 2)',
      inputSchema: {
        type: 'object',
        properties: {
          subcommand: { type: 'string', description: 'Git subcommand (status, log, diff, add, commit, push, etc.)' },
          args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the subcommand' },
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
          suite: { type: 'string', description: 'Test suite: "ts" | "rust" | "lint" | "typecheck" | "all" (default: ts)' },
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
          return runMemphisExec(input);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
    buildTool({
      name: 'memphis_self_modify',
      description:
        'Safe self-modification with snapshot, branch isolation, and test gate',
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
            error:
              'memphis_self_modify requires evolve session repository in this runtime surface',
          };
        }
        return runMemphisSelfModify(input, {
          sessionRepo: deps.evolveSessionRepository,
          rollback: deps.rollback ?? new RollbackManager(getDataDir()),
          caseAdapter: deps.caseAdapter ?? new CaseChainAdapter(),
          projectRoot: deps.projectRoot,
        });
      },
    }),
  ];
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
  const manifest = loadSoulManifest() ?? defaultManifest();
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
      return runtimeTools;
    },
    execute(call: ChatToolCall): Promise<string> {
      return executeTool(call, deps, runtimeToolMap);
    },
    maxParallel: deps.maxParallel ?? 4,
  };
}
