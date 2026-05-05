import type { LoopLimits, LoopState, LlmClient, ToolExecutor } from './chat-types.js';
import { LOOP_LIMITS } from './loop-limits.js';
import {
  buildSystemPrompt as buildMemphisSystemPrompt,
  buildCognitiveContextFragment,
  buildRecalledMemoryFragment,
} from './system-prompt.js';
import { executeToolCalls } from './tool-orchestration.js';
import type { ToolTier } from './tool-registry.js';
import { LOG_LEVEL } from '../config/env-registry.js';
import { getDataDir } from '../config/paths.js';
import type { TokenUsage } from '../core/types.js';
import { resolveAgentProfile } from '../infra/agent-profile.js';
import { createPinoLogger } from '../infra/logging/pino.js';
import {
  detectConfabulation,
  recordConfabulationEvent,
  type ToolResultSnapshot,
} from '../infra/observability/confabulation-detector.js';
import { classifyToolOutput, instrument } from '../infra/observability/instrument.js';
import { resolveInstallRoot } from '../infra/runtime/install-root.js';
import { appendBlock, getChainAdapterStatus } from '../infra/storage/chain-adapter.js';
import {
  NapiChainAdapter,
  type SoulLoopAction,
  type SoulLoopLimits,
  type SoulLoopState,
  type SoulLoopStepResult,
} from '../infra/storage/rust-chain-adapter.js';
import { getRustEmbedAdapterStatus } from '../infra/storage/rust-embed-adapter.js';
import { buildInstalledSkillsPromptFragment } from '../modules/skills/runtime.js';
import type { ChatMessage } from '../providers/index.js';
import {
  buildSoulBootPrompt,
  buildSoulManifestFragment,
  buildSoulMemoryFragment,
} from '../soul/boot.js';
import { ensureSoulManifest, getCognitiveMode } from '../soul/manifest.js';
import { isSoulMemoryEmpty, loadSoulMemory } from '../soul/memory.js';

// Sprint D Phase 1 (PR #428): switched from raw `process.env.LOG_LEVEL ?? 'info'`
// to the centralised env-registry accessor so all readers share one fallback
// chain. See `src/config/env-registry.ts` for the full registered set.
const log = createPinoLogger({ level: LOG_LEVEL.read(process.env) });

export const DEFAULT_LOOP_LIMITS: LoopLimits = { ...LOOP_LIMITS };

let rustLoopAdapter: NapiChainAdapter | null = null;
let rustLoopChecked = false;

function getRustLoopAdapter(): NapiChainAdapter | null {
  if (rustLoopChecked) return rustLoopAdapter;

  // Sprint 1.2 (D1) — flip the gate AFTER assigning the result so a
  // future async-ified probe (NAPI load could become async) can't see
  // checked=true while adapter is still null. Keeps the synchronous
  // contract intact today; hardens against drift.
  // Sprint 2.4 — capture the probe error at warn level so triage can
  // distinguish "Rust loop disabled by operator" from "Rust loop
  // crashed during boot probe" without re-running the probe manually.
  let adapter: NapiChainAdapter | null = null;
  try {
    adapter = new NapiChainAdapter();
    adapter.soulLoopStep(
      { steps: 0, tool_calls: 0, wait_ms: 0, errors: 0, completed: false, halt_reason: null },
      { type: 'complete', data: { summary: 'probe' } },
    );
    log.info('rust loop engine connected');
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'rust loop engine probe failed — using TypeScript fallback (perf regression possible)',
    );
    adapter = null;
  }
  rustLoopAdapter = adapter;
  rustLoopChecked = true;
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
  /**
   * Active surface label (e.g. 'telegram', 'http.chat', 'cli.chat',
   * 'mcp'). Forwarded to `<capabilities>` so the LLM can self-explain
   * "I'm on telegram tier 1" rather than confabulating about tools the
   * surface policy stripped from its list.
   */
  surface?: string;
  /**
   * Effective `maxToolTier` for the active surface (resolved by
   * `surface-policy.ts`). Forwarded to `<capabilities>` so the LLM
   * sees WHY some tier-2 tools are missing from `availableTools`.
   */
  maxToolTier?: ToolTier;
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

  const cognitiveMode = getCognitiveMode(rawEnv);

  // Resolve install root + data dir per turn so the system prompt
  // renders operator-accurate paths. Legacy prompt hardcoded
  // `/home/memphis_ai_brain_on_chain/memphis/` which was tied to a
  // specific host; current operators on different machines (or the
  // npm-installed CLI) never had that path.
  const installRoot = (() => {
    try {
      return resolveInstallRoot({ rawEnv });
    } catch {
      // No install root discoverable — leave undefined so the prompt
      // renders a neutral placeholder rather than a stale path.
      return undefined;
    }
  })();
  const dataDir = getDataDir(rawEnv);

  const base = buildMemphisSystemPrompt({
    rustBridgeActive,
    availableTools: options.availableTools ?? [],
    safeMode: (rawEnv.MEMPHIS_SAFE_MODE ?? '').toLowerCase() === 'true',
    strictMode: (rawEnv.RUST_CHAIN_REQUIRE_SIGNATURES ?? '').toLowerCase() === 'true',
    agentName: resolvedProfile.profile.agentName,
    ownerName: resolvedProfile.profile.ownerName,
    activeCognitiveMode: cognitiveMode,
    installRoot,
    dataDir,
    surface: options.surface,
    maxToolTier: options.maxToolTier,
  });

  const soulBlock = soulParts.length > 0 ? soulParts.join('\n\n') : '';
  const skillBlock = buildInstalledSkillsPromptFragment(rawEnv);
  const full = [soulBlock, skillBlock, base].filter(Boolean).join('\n\n');

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
  usage?: TokenUsage;
  /**
   * Provider-reported reason the response ended. Forwarded from the
   * final ChatResponse on the loop. Memphis uses this to surface
   * truncation warnings — when the value is `length`, the LLM hit
   * `max_tokens` and the reply is incomplete; turn-runtime appends
   * a `[response truncated]` note so the operator doesn't ship a
   * partial answer thinking it's complete.
   */
  finishReason?: string;
};

function mergeTokenUsage(
  current: TokenUsage | undefined,
  next: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!current) return next;
  if (!next) return current;

  const currentTotal =
    typeof current.totalTokens === 'number'
      ? current.totalTokens
      : (current.inputTokens ?? 0) + (current.outputTokens ?? 0);
  const nextTotal =
    typeof next.totalTokens === 'number'
      ? next.totalTokens
      : (next.inputTokens ?? 0) + (next.outputTokens ?? 0);

  const inputTokens =
    (typeof current.inputTokens === 'number' ? current.inputTokens : 0) +
    (typeof next.inputTokens === 'number' ? next.inputTokens : 0);
  const outputTokens =
    (typeof current.outputTokens === 'number' ? current.outputTokens : 0) +
    (typeof next.outputTokens === 'number' ? next.outputTokens : 0);
  const totalTokens = currentTotal + nextTotal;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimated: current.estimated === true || next.estimated === true,
  };
}

export async function runAgentLoop(options: {
  systemPrompt: string;
  messages: ChatMessage[];
  llm: LlmClient;
  toolExecutor?: ToolExecutor;
  loopLimits?: LoopLimits;
  /**
   * Per-turn generation tuning override (cognitive mode dispatch).
   * Forwarded to every llm.complete call so it works for both
   * construction-time-tuned providers (options.provider branch in
   * resolveLlm) and externally-supplied LlmClient instances
   * (options.llm branch — fixes Codex P1 on PR #81).
   */
  temperature?: number;
  maxTokens?: number;
  /**
   * Originating channel surface (telegram | http | cli | mcp | …),
   * forwarded to confabulation events so operators can see WHICH channel
   * produced bad assistant claims. Optional; omitted callers land under
   * 'unknown' in the recorded span.
   */
  surface?: string;
}): Promise<AgentLoopResult> {
  const toolExecutor = options.toolExecutor;
  const tools = toolExecutor?.listTools() ?? [];
  const limits = options.loopLimits ?? DEFAULT_LOOP_LIMITS;
  let state = newLoopState();
  let usage: TokenUsage | undefined;

  const workingMessages = [...options.messages];
  // Sprint 0.2: snapshot of the most recent tool results, used by the
  // confabulation detector to compare the model's eventual claim against
  // tool reality. Reset on each new tool batch so we always check
  // freshest evidence.
  let lastToolResults: ToolResultSnapshot[] = [];

  for (;;) {
    const response = await options.llm.complete({
      system: options.systemPrompt,
      messages: workingMessages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });
    usage = mergeTokenUsage(usage, response.usage);

    void auditLlmCall('provider', response.tool_calls?.length ?? 0);

    if (!response.tool_calls?.length) {
      // Final reply path. If we have tool evidence from a prior iteration,
      // run the confabulation detector against the model's claim. Detector
      // is best-effort: any error here must NOT break the turn — record &
      // continue.
      if (lastToolResults.length > 0 && response.content) {
        try {
          const event = detectConfabulation(lastToolResults, response.content);
          if (event) {
            log.warn(
              {
                rule: event.rule,
                tool: event.toolName,
                surface: options.surface ?? 'unknown',
                evidence: event.evidence.slice(0, 100),
              },
              'confabulation detected',
            );
            recordConfabulationEvent(event, undefined, options.surface);
          }
        } catch (err) {
          log.warn({ err }, 'confabulation detector error — continuing');
        }
      }
      workingMessages.push({ role: 'assistant', content: response.content });
      return {
        reply: response.content,
        messages: workingMessages,
        usage,
        finishReason: response.finishReason,
      };
    }

    workingMessages.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.tool_calls,
    });

    let halted = false;

    const acceptedToolCalls = [];
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
      acceptedToolCalls.push(toolCall);
    }

    const toolResults = await executeToolCalls(
      acceptedToolCalls,
      tools,
      async (toolCall) => {
        if (!toolExecutor) {
          return JSON.stringify({ error: 'no tool executor configured' });
        }
        return instrument(
          'tool.call',
          {
            'tool.name': toolCall.name,
            'tool.id': toolCall.id,
          },
          () => toolExecutor.execute(toolCall),
          {
            postAttributes: (output) => {
              const out = output as string;
              return {
                'tool.output.shape': classifyToolOutput(out),
                'tool.output.length': out.length,
              };
            },
          },
        );
      },
      toolExecutor?.maxParallel ?? 4,
    );

    // Sprint 0.2: capture this batch's tool outputs for the
    // confabulation detector to inspect on the next assistant claim.
    lastToolResults = toolResults.map((tr) => ({
      name: tr.call.name,
      output: tr.output,
    }));

    // Sprint 1.3: pre-emit a system-role hint summarising any tool
    // failures so the LLM cannot fall back on "udało się"-style
    // confabulation when the result message it just received is
    // semantically `{ error: ... }` / `{ ok: false }` / `{ blocked: true }`.
    // The hint is PUSHED BEFORE the tool messages below so the model
    // sees explicit "do not claim success" framing alongside the raw
    // outputs in its next turn. Belt-and-suspenders with the prompt
    // rule in TOOL_DISCIPLINE_PREAMBLE; both target the same failure
    // mode (rationalising 403/permission-denied as success).
    const errorOutputs = toolResults.filter(
      (tr) => classifyToolOutput(tr.output) === 'error',
    );
    if (errorOutputs.length > 0) {
      const summary = errorOutputs
        .map((tr) => {
          let reason = '';
          try {
            const parsed = JSON.parse(tr.output) as Record<string, unknown>;
            const errVal = parsed.error ?? parsed.reason ?? parsed.message;
            if (typeof errVal === 'string') {
              reason = errVal;
            } else if (errVal !== undefined) {
              reason = JSON.stringify(errVal);
            } else {
              reason = tr.output.slice(0, 200);
            }
          } catch {
            reason = tr.output.slice(0, 200);
          }
          return `- ${tr.call.name}: ${(reason ?? 'unspecified error').slice(0, 200)}`;
        })
        .join('\n');
      workingMessages.push({
        role: 'system',
        content:
          `Tool execution surfaced errors (do NOT claim success in your reply):\n${summary}\n\n` +
          `If the user asked for one of these actions, report the failure honestly with the error text. ` +
          `Do not rationalise the denial by inventing config flags, env vars, or runtime modes that don't exist.`,
      });
    }

    for (const toolResult of toolResults) {
      if (toolResult.error) {
        log.error({ tool: toolResult.call.name, err: toolResult.error }, 'tool execution failed');
        const errStep = applyLoopStep(
          state,
          { type: 'error', data: { recoverable: true, message: toolResult.error } },
          limits,
        );
        state = errStep.state;

        if (!errStep.applied) {
          log.warn({ reason: errStep.reason, state }, 'error limit hit');
          halted = true;
        }
      }

      workingMessages.push({
        role: 'tool',
        tool_call_id: toolResult.call.id,
        content: toolResult.output,
      });
      log.info(
        { tool: toolResult.call.name, resultLen: toolResult.output.length },
        'tool executed',
      );
    }

    if (halted) {
      const reply =
        response.content ||
        `I've reached my tool call limit (${state.halt_reason}). Here's what I gathered so far — please ask me to continue if needed.`;
      workingMessages.push({ role: 'assistant', content: reply });
      return {
        reply,
        messages: workingMessages,
        haltReason: state.halt_reason ?? undefined,
        usage,
      };
    }
  }
}
