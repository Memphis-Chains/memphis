/**
 * In-process tool executor — calls Memphis MCP tool functions directly,
 * no HTTP, no MCP client. Used when the gateway runs inside Memphis.
 */

import { recordAuthorizationDecision, resolveToolPolicy } from './authorization.js';
import type { ToolExecutor } from './chat-types.js';
import type { RollbackManager } from '../backup/rollback.js';
import { AppError } from '../core/errors.js';
import type { ChatToolCall, ChatToolDefinition } from '../providers/index.js';
import { loadSoulManifest } from '../soul/manifest.js';
import type { SoulManifest } from '../soul/types.js';
import { createDevelopmentRuntimeTools } from './tool-executor/domains/development-tools.js';
import { createExecRuntimeTools } from './tool-executor/domains/exec-tools.js';
import { createExternalInfoRuntimeTools } from './tool-executor/domains/external-info-tools.js';
import { createFoundationRuntimeTools } from './tool-executor/domains/foundation-tools.js';
import { createMemoryRuntimeTools } from './tool-executor/domains/memory-tools.js';
import { createRuntimeControlTools } from './tool-executor/domains/runtime-control-tools.js';
import { createRuntimeHealthTools } from './tool-executor/domains/runtime-health-tools.js';
import { createSchedulerRuntimeTools } from './tool-executor/domains/scheduler-tools.js';
import { createSelfManagementRuntimeTools } from './tool-executor/domains/self-management-tools.js';
import { createSelfModifyRuntimeTools } from './tool-executor/domains/self-modify-tools.js';
import { createSkillRuntimeTools } from './tool-executor/domains/skill-tools.js';
import { createSoulRuntimeTools } from './tool-executor/domains/soul-tools.js';
import { createStorageRuntimeTools } from './tool-executor/domains/storage-tools.js';
import { isToolEnabledByFeatureFlag } from './tool-registry.js';
import type { RuntimeToolDefinition, ToolExecutionHook } from './tool-runtime.js';
import { CaseChainAdapter } from '../infra/storage/case-chain-adapter.js';
import type { SqliteEvolveSessionRepository } from '../infra/storage/sqlite/repositories/evolve-session-repository.js';
import type { SqliteToolPermissionRepository } from '../infra/storage/sqlite/repositories/tool-permission-repository.js';

export { normalizeCaseQueryForToolCall, normalizeSoulWriteUpdatesForToolCall } from './tool-executor/input-normalization.js';

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

function createRuntimeTools(deps: InProcessToolExecutorDeps): RuntimeToolDefinition[] {
  const tools: RuntimeToolDefinition[] = [
    ...createMemoryRuntimeTools(deps),
    ...createRuntimeHealthTools(deps.rawEnv),
    ...createSoulRuntimeTools(deps.caseAdapter),
    ...createStorageRuntimeTools(deps.caseAdapter, deps.rawEnv),
    ...createExternalInfoRuntimeTools(deps.rawEnv),
    ...createDevelopmentRuntimeTools(),
    ...createSchedulerRuntimeTools(),
    ...createExecRuntimeTools(deps),
    ...createSelfModifyRuntimeTools(deps),
    ...createFoundationRuntimeTools(deps.rawEnv),
    ...createRuntimeControlTools(),
    ...createSelfManagementRuntimeTools(deps.rawEnv, deps.surface),
    ...createSkillRuntimeTools(deps.rawEnv),
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
  // REV2 Temat 3.5: failure-budget reset on any non-exec tool call.
  // The wisdom doctrine in the soul seed tells the agent "if 3 exec
  // failures in a row, stop and re-analyze". We enforce that at the
  // runtime layer; this reset signals "agent moved on from the exec
  // retry loop" and clears the per-(surface, actor) counter so the
  // NEXT exec attempt isn't pre-emptively blocked.
  if (call.name !== 'memphis_exec' && call.name !== 'memphis_exec_analyze') {
    const { resetOnNonExecToolCall } = await import('./exec-failure-budget.js');
    resetOnNonExecToolCall({ surface: deps.surface, actorId: deps.sessionId });
  }
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
      // `deps.conversationId` / `deps.sessionId` / `deps.rawEnv` at
      // execute time). That means a new binding MUST rebuild the
      // tools — a shallow clone of `deps` alone won't reach the
      // existing closures.
      //
      // `binding.rawEnv` carries the per-request env overlay (tier-3
      // elevation from /tier command, surface-tier overrides, etc.).
      // Bootstrap-time `deps.rawEnv` is unset, so without this thread
      // `runMemphisExec` and friends read stale `process.env` and
      // miss the elevation — Block 1853 sibling incident
      // (REV2 Temat 1, 2026-05-12).
      const merged: InProcessToolExecutorDeps = {
        ...deps,
        conversationId: binding.conversationId ?? deps.conversationId,
        sessionId: binding.sessionId ?? deps.sessionId,
        turnId: binding.turnId ?? deps.turnId,
        rawEnv: binding.rawEnv ?? deps.rawEnv,
      };
      return createInProcessToolExecutor(merged);
    },
  };
}
