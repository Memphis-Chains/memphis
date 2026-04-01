import type { LoopLimits, LoopState, LlmClient, ToolExecutor } from './chat-types.js';
import {
  buildSystemPrompt as buildMemphisSystemPrompt,
  buildCognitiveContextFragment,
  buildRecalledMemoryFragment,
} from './system-prompt.js';
import { resolveAgentProfile } from '../infra/agent-profile.js';
import { createPinoLogger } from '../infra/logging/pino.js';
import { appendBlock, getChainAdapterStatus } from '../infra/storage/chain-adapter.js';
import {
  NapiChainAdapter,
  type SoulLoopAction,
  type SoulLoopLimits,
  type SoulLoopState,
  type SoulLoopStepResult,
} from '../infra/storage/rust-chain-adapter.js';
import { getRustEmbedAdapterStatus } from '../infra/storage/rust-embed-adapter.js';
import type { ChatMessage } from '../providers/index.js';
import {
  buildSoulBootPrompt,
  buildSoulManifestFragment,
  buildSoulMemoryFragment,
} from '../soul/boot.js';
import { ensureSoulManifest } from '../soul/manifest.js';
import { isSoulMemoryEmpty, loadSoulMemory } from '../soul/memory.js';

const log = createPinoLogger({ level: process.env.LOG_LEVEL ?? 'info' });

export const DEFAULT_LOOP_LIMITS: LoopLimits = {
  max_steps: 32,
  max_tool_calls: 64, // Increased from 16 for complex tasks
  max_wait_ms: 120_000,
  max_errors: 4,
};

let rustLoopAdapter: NapiChainAdapter | null = null;
let rustLoopChecked = false;

function getRustLoopAdapter(): NapiChainAdapter | null {
  if (!rustLoopChecked) {
    rustLoopChecked = true;
    try {
      const adapter = new NapiChainAdapter();
      adapter.soulLoopStep(
        { steps: 0, tool_calls: 0, wait_ms: 0, errors: 0, completed: false, halt_reason: null },
        { type: 'complete', data: { summary: 'probe' } },
      );
      rustLoopAdapter = adapter;
      log.info('rust loop engine connected');
    } catch {
      log.info('rust loop engine unavailable — using TypeScript fallback');
    }
  }
  return rustLoopAdapter;
}

function applyLoopStep(
  state: LoopState,
  action: SoulLoopAction,
  limits: LoopLimits,
): { applied: boolean; reason?: string; state: LoopState } {
  const rustAdapter = getRustLoopAdapter();

  if (rustAdapter) {
    try {
      const result: SoulLoopStepResult = rustAdapter.soulLoopStep(
        state as SoulLoopState,
        action,
        limits as SoulLoopLimits,
      );
      return { applied: result.applied, reason: result.reason, state: result.state };
    } catch (err) {
      log.warn({ err }, 'rust loop step failed — falling back to TS');
    }
  }

  const nextState = { ...state };
  nextState.steps += 1;

  if (nextState.steps > limits.max_steps) {
    nextState.halt_reason = 'max_steps_exceeded';
    return { applied: false, reason: 'max_steps_exceeded', state: nextState };
  }

  if (action.type === 'tool_call') {
    nextState.tool_calls += 1;
    if (nextState.tool_calls > limits.max_tool_calls) {
      nextState.halt_reason = 'max_tool_calls_exceeded';
      return { applied: false, reason: 'max_tool_calls_exceeded', state: nextState };
    }
  } else if (action.type === 'error') {
    nextState.errors += 1;
    if (nextState.errors > limits.max_errors) {
      nextState.halt_reason = 'max_errors_exceeded';
      return { applied: false, reason: 'max_errors_exceeded', state: nextState };
    }
    if (action.data.recoverable === false) {
      nextState.completed = true;
      nextState.halt_reason = 'non_recoverable_error';
    }
  } else if (action.type === 'complete') {
    nextState.completed = true;
  }

  return { applied: true, state: nextState };
}

async function auditLlmCall(provider: string, toolCallCount: number): Promise<void> {
  try {
    await appendBlock('system', {
      type: 'tool_call',
      content: `LLM call via ${provider}`,
      tags: ['audit', 'llm-call'],
      source: 'gateway',
      provider,
      tool_calls_returned: toolCallCount,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Best-effort audit only.
  }
}

export function newLoopState(): LoopState {
  return { steps: 0, tool_calls: 0, wait_ms: 0, errors: 0, completed: false, halt_reason: null };
}

export type AgentPromptOptions = {
  availableTools?: string[];
  cognitiveContext?: string;
  recalledMemory?: Array<{ content: string; score: number }>;
  rawEnv?: NodeJS.ProcessEnv;
};

export function buildRuntimeSystemPrompt(options: AgentPromptOptions = {}): string {
  const rawEnv = options.rawEnv ?? process.env;
  const resolvedProfile = resolveAgentProfile(rawEnv);
  const rustBridgeActive =
    getChainAdapterStatus(rawEnv).rustBridgeLoaded ||
    getRustEmbedAdapterStatus(rawEnv).embedApiAvailable;

  // Soul system: inject manifest + memory (or boot prompt) before base prompt
  const soulParts: string[] = [];
  try {
    const manifest = ensureSoulManifest(rawEnv);
    soulParts.push(buildSoulManifestFragment(manifest));

    const soulMemory = loadSoulMemory(rawEnv);
    if (soulMemory && !isSoulMemoryEmpty(soulMemory)) {
      soulParts.push(buildSoulMemoryFragment(soulMemory));
    } else {
      soulParts.push(buildSoulBootPrompt(manifest));
    }
  } catch {
    // Soul system is best-effort; don't break the runtime if files are corrupted
  }

  const base = buildMemphisSystemPrompt({
    rustBridgeActive,
    availableTools: options.availableTools ?? [],
    safeMode: (rawEnv.MEMPHIS_SAFE_MODE ?? '').toLowerCase() === 'true',
    strictMode: (rawEnv.RUST_CHAIN_REQUIRE_SIGNATURES ?? '').toLowerCase() === 'true',
    agentName: resolvedProfile.profile.agentName,
    ownerName: resolvedProfile.profile.ownerName,
  });

  const soulBlock = soulParts.length > 0 ? soulParts.join('\n\n') : '';
  const full = soulBlock ? `${soulBlock}\n\n${base}` : base;

  const fragments = [
    options.recalledMemory?.length ? buildRecalledMemoryFragment(options.recalledMemory) : '',
    options.cognitiveContext ? buildCognitiveContextFragment(options.cognitiveContext) : '',
  ].filter(Boolean);

  return fragments.length > 0 ? `${full}\n\n${fragments.join('\n\n')}` : full;
}

export type AgentLoopResult = {
  reply: string;
  messages: ChatMessage[];
  haltReason?: string;
};

export async function runAgentLoop(options: {
  systemPrompt: string;
  messages: ChatMessage[];
  llm: LlmClient;
  toolExecutor?: ToolExecutor;
  loopLimits?: LoopLimits;
}): Promise<AgentLoopResult> {
  const toolExecutor = options.toolExecutor;
  const tools = toolExecutor?.listTools() ?? [];
  const limits = options.loopLimits ?? DEFAULT_LOOP_LIMITS;
  let state = newLoopState();

  const workingMessages = [...options.messages];

  for (;;) {
    const response = await options.llm.complete({
      system: options.systemPrompt,
      messages: workingMessages,
      tools: tools.length > 0 ? tools : undefined,
    });

    void auditLlmCall('provider', response.tool_calls?.length ?? 0);

    if (!response.tool_calls?.length) {
      workingMessages.push({ role: 'assistant', content: response.content });
      return { reply: response.content, messages: workingMessages };
    }

    workingMessages.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.tool_calls,
    });

    let halted = false;

    for (const toolCall of response.tool_calls) {
      const step = applyLoopStep(
        state,
        { type: 'tool_call', data: { tool: toolCall.name } },
        limits,
      );
      state = step.state;

      if (!step.applied) {
        log.warn({ reason: step.reason, tool: toolCall.name, state }, 'loop limit hit');
        halted = true;
        break;
      }

      let result: string;
      try {
        if (!toolExecutor) {
          result = JSON.stringify({ error: 'no tool executor configured' });
        } else {
          result = await toolExecutor.execute(toolCall);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ tool: toolCall.name, err: message }, 'tool execution failed');
        result = JSON.stringify({ error: message });

        const errStep = applyLoopStep(
          state,
          { type: 'error', data: { recoverable: true, message } },
          limits,
        );
        state = errStep.state;

        if (!errStep.applied) {
          log.warn({ reason: errStep.reason, state }, 'error limit hit');
          halted = true;
          break;
        }
      }

      workingMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
      log.info({ tool: toolCall.name, resultLen: result.length }, 'tool executed');
    }

    if (halted) {
      const reply =
        response.content ||
        `I've reached my tool call limit (${state.halt_reason}). Here's what I gathered so far — please ask me to continue if needed.`;
      workingMessages.push({ role: 'assistant', content: reply });
      return { reply, messages: workingMessages, haltReason: state.halt_reason ?? undefined };
    }
  }
}
