import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getChainPath } from '../../config/paths.js';
import type { GenerateInput, GenerateResult, ProviderName } from '../../core/types.js';
import { writeSecurityAudit } from '../../infra/logging/security-audit.js';
import { appendBlock } from '../../infra/storage/chain-adapter.js';
import {
  NapiChainAdapter,
  type SoulLoopAction,
  type SoulLoopLimits,
  type SoulLoopState,
  type SoulLoopStepResult,
} from '../../infra/storage/rust-chain-adapter.js';

export type TaskExecutionContext = {
  taskId?: string;
  runId?: string;
  source?: string;
  agentId?: string;
  enableReplayDedupe?: boolean;
};

export type TaskExecutionRequest = GenerateInput & {
  provider?: 'auto' | ProviderName;
  execution?: TaskExecutionContext;
};

type TaskExecutorDeps = {
  rawEnv?: NodeJS.ProcessEnv;
  chainName?: string;
  appendChain?: typeof appendBlock;
  nowIso?: () => string;
  idFactory?: () => string;
};

type TaskEventCorrelation = {
  taskId: string;
  runId: string;
  agentId: string;
  toolCallId: string | null;
};

type TaskEventEnvelope = {
  schemaVersion: number;
  eventId: string;
  timestamp: string;
  event: string;
  correlation: TaskEventCorrelation;
  payload: Record<string, unknown>;
};

type CachedBlock = {
  data?: {
    content?: unknown;
  };
};

const PROVIDER_TOOL = 'provider.generate';
const DEFAULT_CHAIN = 'system';
const DEFAULT_LOOP_LIMITS: SoulLoopLimits = {
  max_steps: 32,
  max_tool_calls: 16,
  max_wait_ms: 120_000,
  max_errors: 4,
};
const DEFAULT_LOOP_STATE: SoulLoopState = {
  steps: 0,
  tool_calls: 0,
  wait_ms: 0,
  errors: 0,
  completed: false,
  halt_reason: null,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asProviderName(value: unknown): ProviderName | null {
  if (
    value === 'shared-llm' ||
    value === 'decentralized-llm' ||
    value === 'local-fallback' ||
    value === 'ollama'
  ) {
    return value;
  }
  return null;
}

function asGenerateResult(value: unknown): GenerateResult | null {
  if (!isObject(value)) return null;
  const providerUsed = asProviderName(value.providerUsed);
  if (!providerUsed) return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (typeof value.output !== 'string') return null;
  if (
    typeof value.timingMs !== 'number' ||
    !Number.isFinite(value.timingMs) ||
    value.timingMs < 0
  ) {
    return null;
  }

  return {
    id: value.id,
    providerUsed,
    modelUsed: typeof value.modelUsed === 'string' ? value.modelUsed : undefined,
    output: value.output,
    usage: isObject(value.usage) ? (value.usage as GenerateResult['usage']) : undefined,
    timingMs: Math.trunc(value.timingMs),
    trace: isObject(value.trace) ? (value.trace as GenerateResult['trace']) : undefined,
  };
}

function isTrue(raw: string | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}

function applyFallbackLoopStep(
  state: SoulLoopState,
  action: SoulLoopAction,
  limits: SoulLoopLimits,
): SoulLoopStepResult {
  const next: SoulLoopState = {
    ...state,
    steps: state.steps + 1,
  };

  if (next.completed || next.halt_reason) {
    return { applied: false, reason: 'loop_already_halted', state: next };
  }
  if (next.steps > limits.max_steps) {
    next.halt_reason = 'max_steps_exceeded';
    return { applied: false, reason: 'max_steps_exceeded', state: next };
  }

  if (action.type === 'tool_call') {
    next.tool_calls += 1;
    if (next.tool_calls > limits.max_tool_calls) {
      next.halt_reason = 'max_tool_calls_exceeded';
      return { applied: false, reason: 'max_tool_calls_exceeded', state: next };
    }
  } else if (action.type === 'wait') {
    next.wait_ms += Math.max(0, Math.trunc(action.data.duration_ms));
    if (next.wait_ms > limits.max_wait_ms) {
      next.halt_reason = 'max_wait_exceeded';
      return { applied: false, reason: 'max_wait_exceeded', state: next };
    }
  } else if (action.type === 'error') {
    next.errors += 1;
    if (next.errors > limits.max_errors) {
      next.halt_reason = 'max_errors_exceeded';
      return { applied: false, reason: 'max_errors_exceeded', state: next };
    }
    if (!action.data.recoverable) {
      next.completed = true;
      next.halt_reason = 'non_recoverable_error';
    }
  } else if (action.type === 'complete') {
    next.completed = true;
  }

  return { applied: true, state: next };
}

export class TaskExecutor {
  private readonly rawEnv: NodeJS.ProcessEnv;
  private readonly chainName: string;
  private readonly appendChain: typeof appendBlock;
  private readonly nowIso: () => string;
  private readonly idFactory: () => string;
  private soulAdapter: NapiChainAdapter | null = null;
  private soulAdapterResolved = false;

  constructor(deps: TaskExecutorDeps = {}) {
    this.rawEnv = deps.rawEnv ?? process.env;
    this.chainName = deps.chainName ?? DEFAULT_CHAIN;
    this.appendChain = deps.appendChain ?? appendBlock;
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
    this.idFactory = deps.idFactory ?? randomUUID;
  }

  public async execute(
    request: TaskExecutionRequest,
    runProviderGenerate: () => Promise<GenerateResult>,
  ): Promise<GenerateResult> {
    const taskId = request.execution?.taskId ?? `task_${this.idFactory()}`;
    const runId = request.execution?.runId ?? `run_${this.idFactory()}`;
    const source = request.execution?.source ?? 'orchestration.generate';
    const agentId = request.execution?.agentId ?? 'orchestrator';
    const toolCallId = `tool:${PROVIDER_TOOL}:${runId}`;
    const correlationBase: TaskEventCorrelation = {
      taskId,
      runId,
      agentId,
      toolCallId: null,
    };

    let loopState = { ...DEFAULT_LOOP_STATE };
    const inputDigest = createHash('sha256').update(request.input).digest('hex');
    const replayDedupeEnabled =
      request.execution?.enableReplayDedupe ?? Boolean(request.execution?.runId);

    await this.emit('system_event', 'task.created', correlationBase, {
      source,
      providerRequested: request.provider ?? 'auto',
      strategy: request.strategy ?? 'default',
      inputDigest,
      replayDedupeEnabled,
    });

    const toolCallStep = this.applyLoopStep(loopState, {
      type: 'tool_call',
      data: { tool: PROVIDER_TOOL },
    });
    loopState = toolCallStep.state;
    if (!toolCallStep.applied) {
      await this.emit('error', 'task.loop_step_rejected', correlationBase, {
        phase: 'tool_call',
        reason: toolCallStep.reason ?? 'unknown',
      });
      throw new Error(`task loop rejected tool_call: ${toolCallStep.reason ?? 'unknown'}`);
    }

    await this.emit(
      'tool_call',
      'task.tool_call',
      {
        ...correlationBase,
        toolCallId,
      },
      {
        tool: PROVIDER_TOOL,
        inputDigest,
      },
    );

    let result: GenerateResult | null = null;
    if (replayDedupeEnabled) {
      result = await this.findCachedResult(runId, toolCallId);
      if (result) {
        await this.emit(
          'system_event',
          'task.tool_result.reused',
          {
            ...correlationBase,
            toolCallId,
          },
          {
            tool: PROVIDER_TOOL,
            providerUsed: result.providerUsed,
          },
        );
      }
    }

    try {
      if (!result) {
        result = await runProviderGenerate();
        await this.emit(
          'tool_result',
          'task.tool_result',
          {
            ...correlationBase,
            toolCallId,
          },
          {
            tool: PROVIDER_TOOL,
            result,
          },
        );
      }

      const completeStep = this.applyLoopStep(loopState, {
        type: 'complete',
        data: { summary: result.output.slice(0, 120) },
      });
      loopState = completeStep.state;
      if (!completeStep.applied) {
        await this.emit('error', 'task.loop_step_rejected', correlationBase, {
          phase: 'complete',
          reason: completeStep.reason ?? 'unknown',
        });
        throw new Error(`task loop rejected complete: ${completeStep.reason ?? 'unknown'}`);
      }

      await this.emit('system_event', 'task.completed', correlationBase, {
        source,
        providerUsed: result.providerUsed,
        modelUsed: result.modelUsed ?? null,
        replayedToolResult: replayDedupeEnabled,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorStep = this.applyLoopStep(loopState, {
        type: 'error',
        data: { recoverable: false, message },
      });
      loopState = errorStep.state;
      await this.emit('error', 'task.error', correlationBase, {
        message,
        loopState,
      });
      throw error;
    }
  }

  private getSoulAdapter(): NapiChainAdapter | null {
    if (this.soulAdapterResolved) {
      return this.soulAdapter;
    }

    this.soulAdapterResolved = true;
    try {
      this.soulAdapter = new NapiChainAdapter(this.rawEnv);
    } catch {
      this.soulAdapter = null;
    }
    return this.soulAdapter;
  }

  private applyLoopStep(state: SoulLoopState, action: SoulLoopAction): SoulLoopStepResult {
    const adapter = this.getSoulAdapter();
    if (adapter) {
      try {
        return adapter.soulLoopStep(state, action, DEFAULT_LOOP_LIMITS);
      } catch (error) {
        this.soulAdapter = null;
        writeSecurityAudit(
          {
            action: 'task_executor.soul_loop_step',
            status: 'error',
            details: {
              message: error instanceof Error ? error.message : String(error),
              fallback: 'ts-local',
            },
          },
          this.rawEnv,
        );
      }
    }
    return applyFallbackLoopStep(state, action, DEFAULT_LOOP_LIMITS);
  }

  private async emit(
    blockType: 'system_event' | 'tool_call' | 'tool_result' | 'error',
    event: string,
    correlation: TaskEventCorrelation,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (isTrue(this.rawEnv.MEMPHIS_TASK_EXECUTOR_SKIP_CHAIN)) {
      return;
    }

    const envelope: TaskEventEnvelope = {
      schemaVersion: 1,
      eventId: this.idFactory(),
      timestamp: this.nowIso(),
      event,
      correlation,
      payload,
    };
    const tags = [`event:${event}`, `task:${correlation.taskId}`, `run:${correlation.runId}`];
    if (correlation.toolCallId) {
      tags.push(`tool_call:${correlation.toolCallId}`);
    }

    try {
      await this.appendChain(
        this.chainName,
        {
          type: blockType,
          content: JSON.stringify(envelope),
          tags,
        },
        this.rawEnv,
      );
    } catch (error) {
      writeSecurityAudit(
        {
          action: 'task_executor.chain_event',
          status: 'error',
          details: {
            event,
            message: error instanceof Error ? error.message : String(error),
          },
        },
        this.rawEnv,
      );
    }
  }

  private async findCachedResult(
    runId: string,
    toolCallId: string,
  ): Promise<GenerateResult | null> {
    const chainDir = getChainPath(this.chainName, this.rawEnv);
    let files: string[] = [];

    try {
      files = (await readdir(chainDir))
        .filter((file) => file.endsWith('.json'))
        .sort((a, b) => b.localeCompare(a));
    } catch {
      return null;
    }

    for (const file of files) {
      const fullPath = join(chainDir, file);
      try {
        const raw = await readFile(fullPath, 'utf8');
        const block = JSON.parse(raw) as CachedBlock;
        if (typeof block.data?.content !== 'string') continue;

        const envelope = JSON.parse(block.data.content) as Partial<TaskEventEnvelope>;
        if (!envelope || envelope.event !== 'task.tool_result') continue;
        if (envelope.correlation?.runId !== runId) continue;
        if ((envelope.correlation?.toolCallId ?? null) !== toolCallId) continue;

        const cached = asGenerateResult(envelope.payload?.result);
        if (cached) {
          return cached;
        }
      } catch {
        continue;
      }
    }
    return null;
  }
}
