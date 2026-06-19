import { buildRuntimeSystemPrompt, runAgentLoop } from './agent-runtime.js';
import {
  detectConfabulationClaims,
  extractToolsCalled,
  type ConfabAuditResult,
} from './anti-confab-audit.js';
import type { LlmClient, LoopLimits, MemoryClient, ToolExecutor } from './chat-types.js';
import {
  prepareCognitivePrelude,
  runPostResponseCognitivePass,
  type CognitivePrelude,
} from './cognitive-runtime.js';
import type {
  ConversationContextService,
  ConversationPromptOverlay,
} from './conversation-context-service.js';
import {
  auditPromptFragmentAssessment,
  type InputRiskClassification,
  auditInputClassification,
  buildWrappedUserInput,
  classifyUserInput,
  guardModelOutput,
  inspectPromptFragment,
} from './prompt-boundary.js';
import { providerToLlmClient } from './provider-adapter.js';
import { resolveRuntimeEnvironment } from './runtime-environment.js';
import {
  isToolAllowedForSurface,
  resolveSurfacePolicy,
  type SurfacePolicy,
} from './surface-policy.js';
import {
  buildConversationCompactionFragment,
  buildCognitiveContextFragment,
  buildFetchedContentFragment,
  buildRecalledMemoryFragment,
  renderRuntimeEnvironmentBlock,
  buildSessionMemoryFragment,
} from './system-prompt.js';
import { fetchUrlsFromMessage } from './url-extract.js';
import {
  getRecentFrames,
  pushFrame,
  type Frame,
  type FrameTurn,
} from '../cognitive/frame-buffer.js';
import { applyCognitiveMode, type CognitiveModeContribution } from '../cognitive/mode-dispatch.js';
import { LOG_LEVEL } from '../config/env-registry.js';
import { AppError } from '../core/errors.js';
import type { RuntimeTelemetry, TokenUsage } from '../core/types.js';
import { metrics } from '../infra/logging/metrics.js';
import { createPinoLogger } from '../infra/logging/pino.js';
import { instrument } from '../infra/observability/instrument.js';
import {
  buildRuntimeTelemetry,
  estimatePromptTokens,
  recordTurnTelemetry,
} from '../infra/runtime/turn-telemetry.js';
import type { ChatMessage, ChatToolCall, ChatToolDefinition } from '../providers/index.js';
import { resolveModelCapabilitySnapshot } from '../providers/model-capabilities.js';
import type { RuntimeProvider } from '../providers/runtime.js';
import { scanContent } from '../security/content-scan.js';
import { emitRuntimeSecurityEvent } from '../security/runtime-security-events.js';
import {
  buildTier3EnvOverride,
  getActiveTier3Session,
  type Tier3Surface,
} from '../security/tier3-session.js';
import { getCognitiveMode } from '../soul/manifest.js';

const log = createPinoLogger({ level: LOG_LEVEL.read(process.env) });

function generateTurnId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // fall through to random hex fallback
  }
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Strip `<think>...</think>` reasoning blocks from a model reply before
 * it goes to surfaces or persistence.
 *
 * Why: smaller / reasoning-mode-on models (cogito, qwen-thinking,
 * deepseek-r1, etc.) emit visible <think> blocks that are great as a
 * dev trace but pollute the operator-facing reply. Telegram operator
 * 2026-05-04 caught the bot rendering whole 8-line "<think>The user is
 * asking..." preambles into chat messages. The stripping happens at
 * the gateway boundary so every surface — Telegram, TUI, MCP — gets
 * the cleaned text + the provider stamp on top of it.
 *
 * Heuristic: match `<think>...</think>` (case-insensitive, multiline).
 * Also strip a *trailing* unclosed `<think>` block (some models start
 * thinking and forget to close before the end of the stream).
 * Disable with MEMPHIS_THINK_FILTER=0 if a downstream operator needs
 * the raw stream (debug builds, eval harnesses).
 */
export function stripThinkBlocks(output: string, rawEnv: NodeJS.ProcessEnv): string {
  if (rawEnv.MEMPHIS_THINK_FILTER === '0' || rawEnv.MEMPHIS_THINK_FILTER === 'false') {
    return output;
  }
  // Closed blocks: <think>...</think>, lazy match, multi-line.
  let cleaned = output.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
  // Unclosed trailing block: <think> at any position with no closing tag
  // before the end of the message. We also eat any whitespace immediately
  // preceding the opener so we don't leave a dangling blank line.
  cleaned = cleaned.replace(/\s*<think\b[^>]*>[\s\S]*$/i, '');
  return cleaned.trimStart();
}

/**
 * Optional "— via {provider}/{model}" footer. OFF by default — operator
 * 2026-05-12 confirmed the stamp was noise on Telegram (and frequently
 * misleading, since the active provider can change mid-cascade while
 * the stamp shows the call-time provider). The TUI status bar already
 * surfaces the active provider/model on its own, and audit logs carry
 * the same data with more precision; the in-body footer added nothing
 * the operator wanted to see in chat.
 *
 * Keeping the function (rather than ripping out the call site) so
 * power users can flip it back on via `MEMPHIS_PROVIDER_STAMP=1` —
 * useful when bisecting a provider-cascade misroute. The opt-in
 * inverts the prior default; legacy `MEMPHIS_PROVIDER_STAMP=0` is
 * still honored (no-op redundancy) so old .env files keep working.
 */
export function appendProviderStamp(
  output: string,
  provider: string,
  model: string,
  rawEnv: NodeJS.ProcessEnv,
): string {
  const flag = rawEnv.MEMPHIS_PROVIDER_STAMP;
  if (flag !== '1' && flag !== 'true') {
    return output;
  }
  const trimmed = output.trimEnd();
  // The reply normally won't already contain a stamp; this is just a
  // belt-and-braces guard so a model that imitates the format doesn't
  // get double-stamped.
  if (/—\s*via\s+[^/\s]+\/[^\s]+\s*$/i.test(trimmed)) {
    return output;
  }
  const provLabel = provider && provider.length > 0 ? provider : 'unknown';
  const modelLabel = model && model.length > 0 ? model : 'unknown';
  return `${trimmed}\n\n— via ${provLabel}/${modelLabel}`;
}

/**
 * Anti-confab mitigation phase. Read once per turn from
 * `MEMPHIS_ANTICONFAB_PHASE`:
 *   0 — off; no detection, no mutation.
 *   1 — log-only; emit `prompt.output.confab_claim` event, reply
 *       passes through unmodified. (Original Phase 1 ship behavior.)
 *   2 — warn-append; emit `prompt.output.confab_warned`, append a
 *       runtime warning footer to the reply. (Default — autonomy
 *       cycle needs visible correction signal.)
 *   3 — strip-sentence; emit `prompt.output.confab_stripped`, regex-
 *       replace the offending sentence(s). Operator opt-in only;
 *       higher false-positive risk than warn-append.
 *
 * Anything else falls back to the default (2). Operator can force
 * a specific phase per-process for A/B comparisons.
 */
export type ConfabMitigationPhase = 0 | 1 | 2 | 3;
export const DEFAULT_CONFAB_PHASE: ConfabMitigationPhase = 2;

export function resolveConfabPhase(rawEnv: NodeJS.ProcessEnv): ConfabMitigationPhase {
  // S1 operator decision 2026-05-12: phase 3 (strip-sentence) stays
  // opt-in. Operators get a single-purpose toggle
  // (`MEMPHIS_ANTICONFAB_STRIP=1`) so they don't have to remember the
  // numeric phase scale. The explicit phase env still works for A/B
  // experiments + back-compat with existing configs.
  const stripRaw = (rawEnv.MEMPHIS_ANTICONFAB_STRIP ?? '').trim().toLowerCase();
  if (stripRaw === '1' || stripRaw === 'true' || stripRaw === 'on') return 3;

  const raw = (rawEnv.MEMPHIS_ANTICONFAB_PHASE ?? '').trim();
  if (raw === '') return DEFAULT_CONFAB_PHASE;
  switch (raw) {
    case '0':
      return 0;
    case '1':
      return 1;
    case '2':
      return 2;
    case '3':
      return 3;
    default:
      return DEFAULT_CONFAB_PHASE;
  }
}

/**
 * Phase 2: append a one-line runtime warning to the reply when the
 * audit detected unsupported claims. Splice point in the reply
 * mutation chain mirrors `truncationNote` — placed BEFORE the provider
 * stamp so the operator-facing footer reads
 * `[memphis: …] — via anthropic/claude-sonnet-4-6` rather than the
 * other way around.
 *
 * Phase 3: regex-strip the offending sentence(s). Boundary heuristic
 * is `[.!?\n]` — we replace from the previous sentence-end (or string
 * start) up to and including the next sentence-end (or string end).
 * False-positive risk is higher than warn-append because we may eat a
 * legitimate sentence that happened to contain a flagged phrase inside
 * a quote that `looksQuoted` missed — operator opt-in only.
 */
export function appendConfabWarning(
  output: string,
  audit: ConfabAuditResult,
  phase: ConfabMitigationPhase,
): string {
  if (audit.violations.length === 0) return output;
  if (phase === 0 || phase === 1) return output;

  if (phase === 3) {
    return stripConfabSentences(output, audit);
  }

  // Phase 2: warn-append. Lead with the most-egregious category +
  // sample phrase so the operator sees what triggered, not just that
  // something did. Trim the trailing newline before appending so the
  // footer always sits on the same paragraph break.
  const lead = audit.violations[0];
  const others = audit.violations.length - 1;
  const tail = others > 0 ? ` (+${others} more violation${others === 1 ? '' : 's'})` : '';
  const note =
    `\n\n[memphis: claim flagged as unverified — ${lead.category}: ` +
    `"${lead.phrase}". no matching tool was invoked this turn.${tail}]`;
  return output.trimEnd() + note;
}

function stripConfabSentences(output: string, audit: ConfabAuditResult): string {
  // Walk each violation; remove the sentence containing the phrase.
  // We iterate over the in-progress string and accumulate removals so
  // overlapping sentences (multiple violations in one sentence) are
  // collapsed to a single removal. Indices recompute each iteration
  // because the string shrinks as we strip.
  let working = output;
  for (const v of audit.violations) {
    const lower = working.toLowerCase();
    const idx = lower.indexOf(v.phrase.toLowerCase());
    if (idx < 0) continue;
    // Previous sentence terminator (or string start).
    let sentenceStart = 0;
    for (let i = idx - 1; i >= 0; i -= 1) {
      const ch = working[i];
      if (ch === '.' || ch === '!' || ch === '?' || ch === '\n') {
        sentenceStart = i + 1;
        break;
      }
    }
    // Next sentence terminator (or string end).
    let sentenceEnd = working.length;
    for (let i = idx + v.phrase.length; i < working.length; i += 1) {
      const ch = working[i];
      if (ch === '.' || ch === '!' || ch === '?' || ch === '\n') {
        sentenceEnd = i + 1;
        break;
      }
    }
    working = working.slice(0, sentenceStart) + working.slice(sentenceEnd).trimStart();
  }
  return working.trim();
}

function extractFrameToolCalls(messages: ChatMessage[]): string[] {
  const names = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const toolCalls = msg.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        if (call?.name) names.add(call.name);
      }
    }
  }
  return Array.from(names);
}

function extractFrameLastNTurns(
  messages: ChatMessage[],
  originalUserText: string,
  assistantReply: string,
  limit: number = 4,
): FrameTurn[] {
  const turns: FrameTurn[] = [];
  for (const msg of messages.slice(-limit * 2)) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const textValue = msg.content;
    if (!textValue || !textValue.trim()) continue;
    turns.push({ role: msg.role, text: truncateFrameText(textValue) });
  }
  const truncatedUserText = truncateFrameText(originalUserText);
  if (truncatedUserText.length > 0) {
    const alreadyPresent = turns.some(
      (turn) => turn.role === 'user' && turn.text === truncatedUserText,
    );
    if (!alreadyPresent) {
      turns.push({ role: 'user', text: truncatedUserText });
    }
  }
  const truncatedAssistantReply = truncateFrameText(assistantReply);
  if (truncatedAssistantReply.length > 0) {
    turns.push({ role: 'assistant', text: truncatedAssistantReply });
  }
  return turns.slice(-limit);
}

function truncateFrameText(text: string, max: number = 280): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function mapSurfaceToTier3Surface(surface: string): Tier3Surface | null {
  const normalized = surface.toLowerCase();
  if (normalized.startsWith('telegram')) return 'telegram';
  if (normalized.startsWith('http')) return 'http';
  if (
    normalized === 'tui' ||
    normalized.startsWith('tui.') ||
    normalized === 'cli.chat' ||
    normalized === 'cli' ||
    normalized.startsWith('cli.')
  ) {
    return 'tui';
  }
  return null;
}

function applyTier3EnvOverride(
  rawEnv: NodeJS.ProcessEnv,
  surface: string,
  auditSurface: string | undefined,
  actorId: string | undefined,
): NodeJS.ProcessEnv {
  const tier3Surface =
    mapSurfaceToTier3Surface(auditSurface ?? surface) ?? mapSurfaceToTier3Surface(surface);
  if (!tier3Surface) return rawEnv;
  const resolvedActorId = actorId ?? 'local';
  const session = getActiveTier3Session(tier3Surface, resolvedActorId);
  if (!session) return rawEnv;
  const override = buildTier3EnvOverride(tier3Surface, resolvedActorId);
  return { ...rawEnv, ...override };
}

type ToolExecutorLike = {
  execute(call: ChatToolCall): Promise<string>;
  listTools?: () => ChatToolDefinition[];
  /** Optional per-turn binding (N8.2). Canonical executors implement it. */
  withBinding?: (binding: {
    turnId?: string;
    conversationId?: string;
    sessionId?: string;
    /** Per-request rawEnv (tier3 elevation + surface tier override). */
    rawEnv?: NodeJS.ProcessEnv;
  }) => ToolExecutorLike;
};

type TurnPersistenceStatus = {
  sessionUpdated: boolean;
  memoryStoreAttempted: boolean;
  memoryStored: boolean;
  postResponseCognitiveAttempted: boolean;
  postResponseCognitiveOk: boolean;
  degraded: boolean;
  providerDegraded?: boolean;
  providerDegradationReason?: string;
  inputBlocks: string[];
  policyBlocks: string[];
  writeFailures: string[];
  cognitiveFailures: string[];
  errors: string[];
};

function uniquePush(target: string[], ...values: string[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

function recordInputBlock(persistence: TurnPersistenceStatus, ...codes: string[]): void {
  if (codes.length === 0) return;
  persistence.degraded = true;
  uniquePush(persistence.inputBlocks, ...codes);
  uniquePush(persistence.errors, ...codes);
}

function recordPolicyBlock(persistence: TurnPersistenceStatus, ...codes: string[]): void {
  if (codes.length === 0) return;
  persistence.degraded = true;
  uniquePush(persistence.policyBlocks, ...codes);
  uniquePush(persistence.errors, ...codes);
}

function recordWriteFailure(persistence: TurnPersistenceStatus, ...codes: string[]): void {
  if (codes.length === 0) return;
  persistence.degraded = true;
  uniquePush(persistence.writeFailures, ...codes);
  uniquePush(persistence.errors, ...codes);
}

function recordCognitiveFailure(persistence: TurnPersistenceStatus, ...codes: string[]): void {
  if (codes.length === 0) return;
  persistence.degraded = true;
  uniquePush(persistence.cognitiveFailures, ...codes);
  uniquePush(persistence.errors, ...codes);
}

export type TurnRuntimeResult = {
  provider: string;
  model: string;
  timingMs: number;
  output: string;
  messages: ChatMessage[];
  haltReason?: string;
  usage?: TokenUsage;
  telemetry: RuntimeTelemetry;
  persistence: TurnPersistenceStatus;
};

export type TurnRuntimeInput = {
  input?: string;
  messages?: ChatMessage[];
  provider?: RuntimeProvider;
  llm?: LlmClient;
  providerLabel?: string;
  defaultModel?: string;
  model?: string;
  systemPrompt?: string;
  tools?: ChatToolDefinition[];
  toolExecutor?: ToolExecutorLike;
  loopLimits?: LoopLimits;
  memory?: MemoryClient;
  memoryUserId?: string;
  conversationId?: string;
  conversationContext?: ConversationContextService;
  cognitiveRuntimeEnabled?: boolean;
  surface: string;
  auditSurface?: string;
  rawEnv?: NodeJS.ProcessEnv;
  actorId?: string;
  sendReply?: (reply: string) => Promise<void>;
  persistSession?: (entry: {
    userText: string;
    assistantReply: string;
    messages: ChatMessage[];
  }) => Promise<void> | void;
  providerCascade?: { degraded: boolean; tier?: number; reason?: string };
};

type PreparedTurn = {
  messages: ChatMessage[];
  systemPrompt: string;
  originalUserText: string;
  sessionUserText: string;
  memoryUserText: string;
  classification?: InputRiskClassification;
  blockedCapabilities: string[];
  cognitiveModeContribution?: CognitiveModeContribution;
};

type SurfaceToolPolicyResult = {
  toolExecutor?: ToolExecutor;
  blockedToolNames: string[];
};

function dedupeTools(
  localTools: ChatToolDefinition[],
  extraTools: ChatToolDefinition[],
): ChatToolDefinition[] {
  const merged = new Map<string, ChatToolDefinition>();
  for (const tool of localTools) merged.set(tool.name, tool);
  for (const tool of extraTools) {
    if (!merged.has(tool.name)) merged.set(tool.name, tool);
  }
  return Array.from(merged.values());
}

function normalizeToolExecutor(
  toolExecutor: ToolExecutorLike | undefined,
  explicitTools: ChatToolDefinition[] | undefined,
): ToolExecutor | undefined {
  const localTools = toolExecutor?.listTools?.() ?? [];
  const mergedTools = dedupeTools(localTools, explicitTools ?? []);
  if (!toolExecutor && mergedTools.length === 0) return undefined;

  const executableNames = new Set(localTools.map((tool) => tool.name));

  return {
    listTools: () => mergedTools,
    async execute(call: ChatToolCall): Promise<string> {
      if (!toolExecutor) {
        return JSON.stringify({
          error: `tool ${call.name} is not available in this runtime`,
        });
      }
      if (executableNames.size > 0 && !executableNames.has(call.name)) {
        return JSON.stringify({
          error: `tool ${call.name} is not available in this runtime`,
        });
      }
      return toolExecutor.execute(call);
    },
  };
}

function hardenToolExecutor(
  toolExecutor: ToolExecutor | undefined,
  surface: string,
): ToolExecutor | undefined {
  if (!toolExecutor) return undefined;

  return {
    listTools: () => toolExecutor.listTools(),
    async execute(call: ChatToolCall): Promise<string> {
      const output = await toolExecutor.execute(call);
      const assessment = inspectPromptFragment(output, 'tool_output');
      if (assessment.allowed) {
        return output;
      }

      await auditPromptFragmentAssessment(assessment, surface, {
        toolName: call.name,
        toolCallId: call.id,
      });
      return JSON.stringify({
        error: 'tool output blocked by security policy',
        blocked: true,
        tool: call.name,
        risk: assessment.risk,
        flags: assessment.flags,
      });
    },
  };
}

function constrainToolExecutorToSurface(
  toolExecutor: ToolExecutor | undefined,
  surfacePolicy: SurfacePolicy,
  surface: string,
): SurfaceToolPolicyResult {
  if (!toolExecutor) {
    return { toolExecutor: undefined, blockedToolNames: [] };
  }

  const declaredTools = toolExecutor.listTools();
  const allowedTools = declaredTools.filter((tool) =>
    isToolAllowedForSurface(tool.name, surfacePolicy),
  );
  const blockedToolNames = declaredTools
    .filter((tool) => !isToolAllowedForSurface(tool.name, surfacePolicy))
    .map((tool) => tool.name);
  const allowedNames = new Set(allowedTools.map((tool) => tool.name));

  return {
    blockedToolNames,
    toolExecutor: {
      listTools: () => allowedTools,
      async execute(call: ChatToolCall): Promise<string> {
        if (
          !isToolAllowedForSurface(call.name, surfacePolicy) ||
          (allowedNames.size > 0 && !allowedNames.has(call.name))
        ) {
          return JSON.stringify({
            error: 'tool blocked by surface policy',
            blocked: true,
            tool: call.name,
            surface,
            maxToolTier: surfacePolicy.maxToolTier,
          });
        }
        return toolExecutor.execute(call);
      },
    },
  };
}

function normalizeQueryText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findLatestUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') return normalizeQueryText(message.content);
  }
  return '';
}

function updateFinalAssistantMessage(messages: ChatMessage[], reply: string): ChatMessage[] {
  const next = [...messages];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const message = next[i];
    if (message?.role !== 'assistant') continue;
    next[i] = { ...message, content: reply };
    break;
  }
  return next;
}

function trimConversationMessages(
  messages: ChatMessage[],
  limit: number | undefined,
): ChatMessage[] {
  if (!limit || messages.length <= limit) return [...messages];

  const hasSystemMessage = messages[0]?.role === 'system';
  const systemPrefix = hasSystemMessage ? [messages[0]!] : [];
  const tail = messages.slice(messages.length - limit);
  return hasSystemMessage
    ? [...systemPrefix, ...tail.filter((message) => message.role !== 'system')]
    : tail;
}

type ContextWindowGuardResult = {
  messages: ChatMessage[];
  trimmedMessages: number;
  truncatedMessages: number;
};

function truncateChatMessageContent(message: ChatMessage, maxChars: number): ChatMessage {
  if (!('content' in message) || message.content.length <= maxChars) return message;
  const marker = '\n\n[context trimmed: message shortened before provider call]';
  const safeMax = Math.max(64, maxChars - marker.length);
  if (message.content.length <= safeMax + marker.length) return message;
  if (safeMax <= 128) {
    return { ...message, content: message.content.slice(0, safeMax).trimEnd() + marker };
  }
  const headChars = Math.floor(safeMax * 0.65);
  const tailChars = Math.max(64, safeMax - headChars);
  return {
    ...message,
    content:
      message.content.slice(0, headChars).trimEnd() +
      marker +
      '\n\n' +
      message.content.slice(-tailChars).trimStart(),
  };
}

function enforceContextWindowBeforeProvider(input: {
  provider: string;
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
}): ContextWindowGuardResult {
  const capability = resolveModelCapabilitySnapshot(input.provider, input.model);
  const contextWindowTokens = capability?.contextWindowTokens;
  if (!contextWindowTokens || contextWindowTokens <= 0) {
    return { messages: input.messages, trimmedMessages: 0, truncatedMessages: 0 };
  }

  const targetTokens = Math.max(512, Math.floor(contextWindowTokens * 0.92));
  let messages = [...input.messages];
  let trimmedMessages = 0;
  let truncatedMessages = 0;

  const estimate = () =>
    estimatePromptTokens({ systemPrompt: input.systemPrompt, messages });

  while (messages.length > 1 && estimate() > targetTokens) {
    const dropIndex = messages.findIndex(
      (message, index) => index < messages.length - 1 && message.role !== 'system',
    );
    if (dropIndex < 0) break;
    messages = [...messages.slice(0, dropIndex), ...messages.slice(dropIndex + 1)];
    trimmedMessages += 1;
  }

  while (estimate() > targetTokens) {
    const candidates = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.role !== 'system' && 'content' in message);
    const largest = candidates.sort(
      (a, b) => b.message.content.length - a.message.content.length,
    )[0];
    if (!largest || largest.message.content.length <= 128) break;

    const currentTokens = estimate();
    const excessTokens = currentTokens - targetTokens;
    const reduceChars = Math.max(excessTokens * 4 + 512, Math.floor(largest.message.content.length * 0.25));
    const maxChars = Math.max(128, largest.message.content.length - reduceChars);
    const nextMessage = truncateChatMessageContent(largest.message, maxChars);
    if (nextMessage.content.length >= largest.message.content.length) break;
    messages = messages.map((message, index) => (index === largest.index ? nextMessage : message));
    truncatedMessages += 1;
  }

  return { messages, trimmedMessages, truncatedMessages };
}

function buildEffectiveSystemPrompt(options: {
  baseSystemPrompt?: string;
  availableTools: string[];
  cognitiveContext?: string;
  recalledMemory: Array<{ content: string; score: number }>;
  sessionMemory?: string;
  compactions?: Array<{ summary: string; startSequence: number; endSequence: number }>;
  rawEnv?: NodeJS.ProcessEnv;
  surface?: string;
  surfacePolicy?: SurfacePolicy;
  providerLabel?: string;
  modelLabel?: string;
}): string {
  const base = options.baseSystemPrompt?.trim();
  const basePrompt = base
    ? base
    : buildRuntimeSystemPrompt({
        availableTools: options.availableTools,
        cognitiveContext: options.cognitiveContext,
        recalledMemory: options.recalledMemory,
        rawEnv: options.rawEnv,
        surface: options.surface,
        maxToolTier: options.surfacePolicy?.maxToolTier,
        providerLabel: options.providerLabel,
        modelLabel: options.modelLabel,
      });

  const fragments: string[] = [];
  if (base) {
    const perTurnIntrospection = buildPerTurnIntrospectionFragment({
      availableTools: options.availableTools,
      providerLabel: options.providerLabel,
      modelLabel: options.modelLabel,
      rawEnv: options.rawEnv,
    });
    if (perTurnIntrospection) fragments.push(perTurnIntrospection);
  }
  if (base && options.recalledMemory.length > 0) {
    fragments.push(buildRecalledMemoryFragment(options.recalledMemory));
  }
  if (options.sessionMemory && options.sessionMemory.trim().length > 0) {
    fragments.push(buildSessionMemoryFragment(options.sessionMemory));
  }
  if (options.compactions && options.compactions.length > 0) {
    const fragment = buildConversationCompactionFragment(options.compactions);
    if (fragment) fragments.push(fragment);
  }
  if (options.cognitiveContext && options.cognitiveContext.trim().length > 0) {
    fragments.push(buildCognitiveContextFragment(options.cognitiveContext));
  }

  return [basePrompt, ...fragments].filter(Boolean).join('\n\n');
}

function buildPerTurnIntrospectionFragment(options: {
  availableTools: string[];
  providerLabel?: string;
  modelLabel?: string;
  rawEnv?: NodeJS.ProcessEnv;
}): string {
  const lines: string[] = [];
  if (options.providerLabel || options.modelLabel) {
    lines.push(
      '<runtime_route>',
      `Provider selected for this turn: ${options.providerLabel ?? 'unknown'}.`,
      `Model selected for this turn: ${options.modelLabel ?? 'unknown'}.`,
      'This block is the authoritative answer for "what model/provider are you using right now?" Do not claim you cannot know it when this block is present.',
      '</runtime_route>',
    );
  }
  lines.push(renderRuntimeEnvironmentBlock(resolveRuntimeEnvironment(options.rawEnv)));
  if (options.availableTools.includes('memphis_self_describe')) {
    lines.push(
      '<self_introspection_rule>',
      'If the operator asks "tools?", "what can you do?", "capabilities?", or similar, call `memphis_self_describe` immediately and answer from its JSON. Do not ask for confirmation first; it is a tier-0 read-only introspection tool.',
      '</self_introspection_rule>',
    );
  }
  return lines.join('\n');
}

async function prepareTextTurn(
  input: string,
  options: TurnRuntimeInput,
  availableTools: string[],
  classification: InputRiskClassification | undefined,
  surfacePolicy: SurfacePolicy,
  conversationOverlay?: ConversationPromptOverlay,
): Promise<PreparedTurn> {
  let recalledMemory: Array<{ content: string; score: number }> = [];
  let cognitiveContext = '';
  let fetchedBlocks = '';
  const blockedCapabilities: string[] = [];
  const highRisk = classification?.risk === 'high';

  try {
    if (options.memory && options.memoryUserId && input.trim().length > 0 && !highRisk) {
      if (!surfacePolicy.allowMemoryRecall) {
        blockedCapabilities.push('memory_recall_surface_policy_blocked');
      } else {
        const recalled = await options.memory.recall(options.memoryUserId, input, 5);
        const nextRecalledMemory: Array<{ content: string; score: number }> = [];
        for (const item of recalled.items) {
          const assessment = inspectPromptFragment(item.content, 'recalled_memory');
          if (!assessment.allowed) {
            blockedCapabilities.push('recalled_memory_blocked');
            await auditPromptFragmentAssessment(
              assessment,
              options.auditSurface ?? options.surface,
              {
                score: item.score ?? 0.5,
              },
            );
            continue;
          }
          nextRecalledMemory.push({
            content: item.content,
            score: item.score ?? 0.5,
          });
        }
        recalledMemory = nextRecalledMemory;
      }
    } else if (highRisk) {
      blockedCapabilities.push('memory_recall');
    }
  } catch (error) {
    log.warn({ err: error, surface: options.surface }, 'turn recall failed');
  }

  try {
    if (!surfacePolicy.allowUrlFetch) {
      if (/(https?:\/\/|www\.)/i.test(input)) {
        blockedCapabilities.push('url_fetch_surface_policy_blocked');
      }
    } else if (!highRisk) {
      const fetched = await fetchUrlsFromMessage(input);
      const allowedFetched = [];
      for (const item of fetched) {
        const assessment = inspectPromptFragment(item.content, 'fetched_content');
        if (!assessment.allowed) {
          blockedCapabilities.push('fetched_content_blocked');
          await auditPromptFragmentAssessment(assessment, options.auditSurface ?? options.surface, {
            url: item.url,
          });
          continue;
        }
        allowedFetched.push(item);
      }
      if (allowedFetched.length > 0) {
        fetchedBlocks = allowedFetched
          .map((item) => buildFetchedContentFragment(item.url, item.content))
          .join('\n\n');
      }
    } else {
      blockedCapabilities.push('url_fetch');
    }
  } catch (error) {
    log.warn({ err: error, surface: options.surface }, 'turn url fetch failed');
  }

  let cognitiveModeContribution: CognitiveModeContribution | undefined;
  if (options.cognitiveRuntimeEnabled !== false && !highRisk) {
    if (!surfacePolicy.allowCognitivePrelude) {
      blockedCapabilities.push('cognitive_prelude_surface_policy_blocked');
    } else {
      let prelude: CognitivePrelude | undefined;
      try {
        prelude = await prepareCognitivePrelude(input);
        cognitiveContext = prelude.promptFragment;
      } catch (error) {
        log.warn({ err: error, surface: options.surface }, 'turn cognitive prelude failed');
      }
      cognitiveModeContribution = computeCognitiveModeContribution(
        options.rawEnv ?? process.env,
        prelude,
      );
      cognitiveContext = mergeModeFragment(cognitiveContext, cognitiveModeContribution);
    }
  } else if (highRisk) {
    blockedCapabilities.push('cognitive_prelude');
  }

  const wrappedUserInput = buildWrappedUserInput(input, classification ?? classifyUserInput(input));
  const llmUserText = fetchedBlocks ? `${wrappedUserInput}\n\n${fetchedBlocks}` : wrappedUserInput;
  const sessionUserText = highRisk
    ? `[high-risk user input omitted hash=${classification?.contentHash}]`
    : llmUserText;
  const routeLabels = resolvePromptRouteLabels(options);

  return {
    messages: [...(options.messages ?? []), { role: 'user', content: llmUserText }],
    systemPrompt: buildEffectiveSystemPrompt({
      baseSystemPrompt: options.systemPrompt,
      availableTools,
      cognitiveContext,
      recalledMemory,
      sessionMemory: conversationOverlay?.sessionMemory,
      compactions: conversationOverlay?.compactions,
      rawEnv: options.rawEnv,
      surface: options.auditSurface ?? options.surface,
      surfacePolicy,
      providerLabel: routeLabels.providerLabel,
      modelLabel: routeLabels.modelLabel,
    }),
    originalUserText: input,
    sessionUserText,
    memoryUserText: highRisk ? '' : input,
    classification,
    blockedCapabilities,
    cognitiveModeContribution,
  };
}

async function prepareMessagesTurn(
  messages: ChatMessage[],
  options: TurnRuntimeInput,
  availableTools: string[],
  classification: InputRiskClassification | undefined,
  surfacePolicy: SurfacePolicy,
  conversationOverlay?: ConversationPromptOverlay,
): Promise<PreparedTurn> {
  const originalUserText = findLatestUserText(messages);
  let memoryUserText = originalUserText;
  let recalledMemory: Array<{ content: string; score: number }> = [];
  let cognitiveContext = '';
  let cognitiveModeContribution: CognitiveModeContribution | undefined;
  const blockedCapabilities: string[] = [];
  const highRisk = classification?.risk === 'high';

  if (originalUserText.length > 0) {
    if (highRisk) {
      memoryUserText = '';
    }

    try {
      if (options.memory && options.memoryUserId && !highRisk) {
        if (!surfacePolicy.allowMemoryRecall) {
          blockedCapabilities.push('memory_recall_surface_policy_blocked');
        } else {
          const recalled = await options.memory.recall(options.memoryUserId, originalUserText, 5);
          const nextRecalledMemory: Array<{ content: string; score: number }> = [];
          for (const item of recalled.items) {
            const assessment = inspectPromptFragment(item.content, 'recalled_memory');
            if (!assessment.allowed) {
              blockedCapabilities.push('recalled_memory_blocked');
              await auditPromptFragmentAssessment(
                assessment,
                options.auditSurface ?? options.surface,
                {
                  score: item.score ?? 0.5,
                },
              );
              continue;
            }
            nextRecalledMemory.push({
              content: item.content,
              score: item.score ?? 0.5,
            });
          }
          recalledMemory = nextRecalledMemory;
        }
      } else if (highRisk) {
        blockedCapabilities.push('memory_recall');
      }
    } catch (error) {
      log.warn({ err: error, surface: options.surface }, 'turn recall failed');
    }

    if (options.cognitiveRuntimeEnabled !== false && !highRisk) {
      if (!surfacePolicy.allowCognitivePrelude) {
        blockedCapabilities.push('cognitive_prelude_surface_policy_blocked');
      } else {
        let prelude: CognitivePrelude | undefined;
        try {
          prelude = await prepareCognitivePrelude(originalUserText);
          cognitiveContext = prelude.promptFragment;
        } catch (error) {
          log.warn({ err: error, surface: options.surface }, 'turn cognitive prelude failed');
        }
        cognitiveModeContribution = computeCognitiveModeContribution(
          options.rawEnv ?? process.env,
          prelude,
        );
        cognitiveContext = mergeModeFragment(cognitiveContext, cognitiveModeContribution);
      }
    } else if (highRisk) {
      blockedCapabilities.push('cognitive_prelude');
    }
  }

  const routeLabels = resolvePromptRouteLabels(options);

  return {
    messages: [...messages],
    systemPrompt: buildEffectiveSystemPrompt({
      baseSystemPrompt: options.systemPrompt,
      availableTools,
      cognitiveContext,
      recalledMemory,
      sessionMemory: conversationOverlay?.sessionMemory,
      compactions: conversationOverlay?.compactions,
      rawEnv: options.rawEnv,
      surface: options.auditSurface ?? options.surface,
      surfacePolicy,
      providerLabel: routeLabels.providerLabel,
      modelLabel: routeLabels.modelLabel,
    }),
    originalUserText,
    sessionUserText: highRisk
      ? `[high-risk user input omitted hash=${classification?.contentHash}]`
      : originalUserText,
    memoryUserText,
    classification,
    blockedCapabilities,
    cognitiveModeContribution,
  };
}

function computeCognitiveModeContribution(
  rawEnv: NodeJS.ProcessEnv,
  prelude: CognitivePrelude | undefined,
): CognitiveModeContribution {
  const mode = getCognitiveMode(rawEnv);
  return applyCognitiveMode(
    mode,
    {
      blocks: prelude?.blocks,
      inferred: prelude?.inferred,
      predictions: prelude?.predictions,
      frames: mode === 'A' ? getRecentFrames() : undefined,
    },
    rawEnv,
  );
}

function mergeModeFragment(
  existing: string,
  contribution: CognitiveModeContribution | undefined,
): string {
  if (!contribution?.promptFragment) return existing;
  if (!existing) return contribution.promptFragment;
  return `${existing}\n${contribution.promptFragment}`;
}

function replaceLatestUserMessage(messages: ChatMessage[], content: string): ChatMessage[] {
  const next = [...messages];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const message = next[i];
    if (message?.role !== 'user') continue;
    next[i] = { ...message, content };
    break;
  }
  return next;
}

async function resolveInputClassification(
  options: TurnRuntimeInput,
): Promise<InputRiskClassification | undefined> {
  const candidate =
    typeof options.input === 'string' ? options.input : findLatestUserText(options.messages ?? []);
  if (!candidate.trim()) return undefined;

  const classification = classifyUserInput(candidate);
  const auditSurface = options.auditSurface ?? options.surface;
  await auditInputClassification(classification, auditSurface);
  if (classification.risk === 'high') {
    await emitRuntimeSecurityEvent({
      action: 'prompt.input.capabilities.degraded',
      status: 'blocked',
      details: {
        surface: auditSurface,
        risk: classification.risk,
        flags: classification.flags,
        contentHash: classification.contentHash,
      },
    });
  }
  return classification;
}

function resolveLlm(
  options: TurnRuntimeInput,
  contribution?: CognitiveModeContribution,
): {
  llm: LlmClient;
  provider: string;
  model: string;
} {
  if (options.provider) {
    return {
      llm: providerToLlmClient(
        options.provider,
        {
          model: options.model,
          temperature: contribution?.temperature,
          maxTokens: contribution?.maxTokens,
        },
        { providerLabel: options.provider.name, modelLabel: options.provider.defaultModel() },
      ),
      provider: options.provider.name,
      model: options.model ?? options.provider.defaultModel(),
    };
  }

  if (options.llm) {
    return {
      llm: options.llm,
      provider: options.providerLabel ?? 'provider',
      model: options.model ?? options.defaultModel ?? 'unknown',
    };
  }

  throw new Error('turn runtime requires provider or llm');
}

function resolvePromptRouteLabels(options: TurnRuntimeInput): {
  providerLabel?: string;
  modelLabel?: string;
} {
  if (options.provider) {
    return {
      providerLabel: options.provider.name,
      modelLabel: options.model ?? options.provider.defaultModel(),
    };
  }
  return {
    providerLabel: options.providerLabel,
    modelLabel: options.model ?? options.defaultModel,
  };
}

function createInitialPersistence(): TurnPersistenceStatus {
  return {
    sessionUpdated: true,
    memoryStoreAttempted: false,
    memoryStored: false,
    postResponseCognitiveAttempted: false,
    postResponseCognitiveOk: false,
    degraded: false,
    inputBlocks: [],
    policyBlocks: [],
    writeFailures: [],
    cognitiveFailures: [],
    errors: [],
  };
}

export async function runTurnRuntime(options: TurnRuntimeInput): Promise<TurnRuntimeResult> {
  return instrument(
    'turn.dispatch',
    {
      surface: options.surface,
      'audit.surface': options.auditSurface ?? options.surface,
      'conversation.id': options.conversationId ?? 'none',
      'actor.id': options.actorId ?? 'local',
    },
    () => runTurnRuntimeImpl(options),
    {
      postAttributes: (r) => {
        const result = r as TurnRuntimeResult;
        return {
          provider: result.provider,
          model: result.model,
          'turn.timing_ms': result.timingMs,
          'turn.halt_reason': result.haltReason ?? 'none',
          'turn.persistence.degraded': result.persistence.degraded,
        };
      },
    },
  );
}

async function runTurnRuntimeImpl(options: TurnRuntimeInput): Promise<TurnRuntimeResult> {
  const startedAt = Date.now();
  const turnId = generateTurnId();
  const classification = await resolveInputClassification(options);
  const auditSurface = options.auditSurface ?? options.surface;
  const rawEnvWithTier3 = applyTier3EnvOverride(
    options.rawEnv ?? process.env,
    options.surface,
    options.auditSurface,
    options.actorId,
  );

  // Phase 2.2 production sprint: admission control. Throws 429 if the
  // queue is full so callers can surface "system saturated, try again"
  // instead of OOMing under a flood. ticket.release() in finally so
  // even uncaught exceptions free the slot.
  const { acquireTurnSlot } = await import('../infra/runtime/turn-admission.js');
  const admissionTicket = await acquireTurnSlot(rawEnvWithTier3);

  try {
    const surfacePolicy = resolveSurfacePolicy(auditSurface, rawEnvWithTier3);
    const conversationOverlay =
      options.conversationContext && options.conversationId
        ? await options.conversationContext.getPromptOverlay(options.conversationId)
        : undefined;
    // Bind the tool executor to this turn's conversation so
    // tool-emitted journal writes (e.g. `memphis_journal` invoked by
    // the model) land with the same `conversation_id` as memory-client
    // writes. Executors that don't implement `withBinding` keep their
    // original deps — backward compat.
    const boundToolExecutor =
      options.toolExecutor && options.toolExecutor.withBinding
        ? options.toolExecutor.withBinding({
            turnId,
            conversationId: options.conversationId,
            // Block 1853 sibling fix (2026-05-12) — pass the
            // tier3-merged env so per-request elevation (Telegram
            // /tier command, etc.) actually reaches runMemphisExec's
            // policy gate. Bootstrap-time toolExecutor has no
            // rawEnv set in deps, so without this binding the
            // override is silently dropped.
            rawEnv: rawEnvWithTier3,
          })
        : options.toolExecutor;
    const rawToolExecutor = normalizeToolExecutor(boundToolExecutor, options.tools);
    const constrainedTools = constrainToolExecutorToSurface(
      rawToolExecutor,
      surfacePolicy,
      auditSurface,
    );
    const highRisk = classification?.risk === 'high';
    const normalizedToolExecutor = highRisk
      ? undefined
      : hardenToolExecutor(constrainedTools.toolExecutor, auditSurface);
    const availableTools = normalizedToolExecutor?.listTools().map((tool) => tool.name) ?? [];
    const baseMessages = trimConversationMessages(
      options.messages ?? [],
      conversationOverlay?.trimRecentMessagesTo,
    );
    const prepared =
      typeof options.input === 'string'
        ? await prepareTextTurn(
            options.input,
            { ...options, messages: baseMessages },
            availableTools,
            classification,
            surfacePolicy,
            conversationOverlay,
          )
        : await prepareMessagesTurn(
            baseMessages,
            options,
            availableTools,
            classification,
            surfacePolicy,
            conversationOverlay,
          );
    if (constrainedTools.blockedToolNames.length > 0) {
      await emitRuntimeSecurityEvent({
        action: 'surface_policy.tools.blocked',
        status: 'blocked',
        details: {
          surface: auditSurface,
          blockedTools: constrainedTools.blockedToolNames,
          maxToolTier: surfacePolicy.maxToolTier,
        },
      });
    }
    const llm = resolveLlm(options, prepared.cognitiveModeContribution);
    // Phase 1.3 production sprint: pre-flight check the provider budget.
    // Throws PROVIDER_RATE_LIMIT (429) if cap is exceeded; the cascade
    // caller catches and falls through to the next tier.
    try {
      const { checkProviderBudget } = await import('../infra/runtime/cost-cap.js');
      checkProviderBudget(llm.provider, rawEnvWithTier3);
    } catch (capError) {
      metrics.recordProviderCall(llm.provider, false, Date.now() - startedAt);
      throw capError;
    }
    // Phase 2.1 production sprint: circuit breaker — if this provider has
    // tripped recently, fail fast so the cascade falls through to the
    // next tier instead of waiting for another timeout.
    try {
      const { admitProviderCall } = await import('../infra/runtime/circuit-breaker.js');
      admitProviderCall(llm.provider, rawEnvWithTier3);
    } catch (breakerError) {
      metrics.recordProviderCall(llm.provider, false, Date.now() - startedAt);
      throw breakerError;
    }
    const contextGuard = enforceContextWindowBeforeProvider({
      provider: llm.provider,
      model: llm.model,
      systemPrompt: prepared.systemPrompt,
      messages: prepared.messages,
    });
    let result: Awaited<ReturnType<typeof runAgentLoop>>;
    try {
      result = await runAgentLoop({
        systemPrompt: prepared.systemPrompt,
        messages: contextGuard.messages,
        llm: llm.llm,
        toolExecutor: normalizedToolExecutor,
        loopLimits: options.loopLimits,
        // Codex P1 fix (PR #81): forward cognitive-mode tuning for both
        // resolveLlm branches. Without this, runs against externally
        // supplied LlmClient instances (chat-loop path → options.llm)
        // never picked up mode-A's `temperature: 0.3` or any per-mode
        // maxTokens ceiling.
        temperature: prepared.cognitiveModeContribution?.temperature,
        maxTokens: prepared.cognitiveModeContribution?.maxTokens,
        // Stamp confabulation events with the originating channel so
        // operators can see WHICH surface (telegram, http, cli, mcp …)
        // produced the bad claim. Audit surface tracks the canonical
        // origin even when the runtime is impersonating another tier.
        surface: auditSurface,
      });
    } catch (error) {
      metrics.recordProviderCall(llm.provider, false, Date.now() - startedAt);
      // Phase 2.1: record outcome for the breaker. A run of failures trips
      // the breaker and subsequent calls fail fast.
      //
      // Codex Round 6 P1 (PR #122): only count TRANSIENT provider faults
      // against the breaker. Validation / 4xx bursts must not trip it.
      // PROVIDER_TIMEOUT / PROVIDER_UNAVAILABLE / PROVIDER_RATE_LIMIT are
      // the AppError codes that genuinely indicate provider-side trouble.
      //
      // Codex P1 follow-up (on PR #141): the prior revision SKIPPED the
      // breaker call entirely for non-transient errors, which stranded
      // the halfOpenProbeInFlight flag set by admitProviderCall — every
      // subsequent call then failed fast as "probe in flight" until
      // process restart. Now we always settle the probe flag; the
      // countAsTrip flag distinguishes transient (counts) from
      // non-transient (settles probe without tripping).
      try {
        const isTransient =
          error instanceof AppError &&
          (error.code === 'PROVIDER_TIMEOUT' ||
            error.code === 'PROVIDER_UNAVAILABLE' ||
            error.code === 'PROVIDER_RATE_LIMIT');
        const { recordProviderOutcome } = await import('../infra/runtime/circuit-breaker.js');
        recordProviderOutcome(llm.provider, false, rawEnvWithTier3, Date.now(), {
          countAsTrip: isTransient,
        });
      } catch {
        /* breaker recording is best-effort */
      }
      throw error;
    }
    metrics.recordProviderCall(llm.provider, true, Date.now() - startedAt);
    try {
      const { recordProviderOutcome } = await import('../infra/runtime/circuit-breaker.js');
      recordProviderOutcome(llm.provider, true, rawEnvWithTier3);
    } catch {
      /* breaker recording is best-effort */
    }

    // Phase 1.3 production sprint: record token usage post-call so the
    // budget counter advances. Uses any usage telemetry runAgentLoop
    // returned. Soft-warning thresholds (50/75/90%) emit a one-shot alert.
    try {
      const { recordProviderUsage, consumeSoftWarning } =
        await import('../infra/runtime/cost-cap.js');
      const inTok = result.usage?.inputTokens ?? 0;
      const outTok = result.usage?.outputTokens ?? 0;
      if (inTok > 0 || outTok > 0) {
        recordProviderUsage(llm.provider, inTok, outTok, rawEnvWithTier3);
        const warn = consumeSoftWarning(llm.provider, rawEnvWithTier3);
        if (warn !== null) {
          await emitRuntimeSecurityEvent({
            action: 'provider.budget.soft_warning',
            status: 'allowed',
            details: { provider: llm.provider, threshold: warn },
          });
        }
      }
    } catch {
      // budget tracking is best-effort; never let it break a turn
    }

    const guarded = await guardModelOutput(result.reply, options.auditSurface ?? options.surface);

    // Anti-confab runtime audit (Sprint Continue 2).
    // Scan the reply for forbidden persistence/search/capability claims
    // and cross-reference the tool calls that fired in this turn. If
    // a forbidden phrase appears WITHOUT the matching whitelisted tool,
    // emit a runtime security event AND, depending on
    // `MEMPHIS_ANTICONFAB_PHASE`, optionally mutate the reply
    // (warn-append at phase 2 — the default; strip-sentence at
    // phase 3 — opt-in).
    //
    // Hoisted out of the try{} so the cleanedOutput chain below can
    // splice the warning footer in. Audit failure is non-fatal — `null`
    // means "skip the mutation, still ship the reply".
    const confabPhase = resolveConfabPhase(rawEnvWithTier3);
    let confabAudit: ConfabAuditResult | null = null;
    if (confabPhase !== 0) {
      try {
        const toolsCalledInTurn = extractToolsCalled(result.messages);
        confabAudit = detectConfabulationClaims(guarded.output, toolsCalledInTurn);
        if (confabAudit.violations.length > 0) {
          const action =
            confabPhase === 1
              ? 'prompt.output.confab_claim'
              : confabPhase === 2
                ? 'prompt.output.confab_warned'
                : 'prompt.output.confab_stripped';
          const status = confabPhase === 1 ? 'allowed' : 'mitigated';
          await emitRuntimeSecurityEvent({
            action,
            status,
            details: {
              surface: options.auditSurface ?? options.surface,
              categories: Array.from(new Set(confabAudit.violations.map((v) => v.category))),
              count: confabAudit.violations.length,
              phase: confabPhase,
              // First violation's excerpt is enough for triage; full list
              // would bloat the audit chain.
              sampleExcerpt: confabAudit.violations[0]?.excerpt ?? '',
              samplePhrase: confabAudit.violations[0]?.phrase ?? '',
            },
          });
        }
      } catch (err) {
        // Audit must never break a turn. Swallow + log; the reply still ships.
        log.warn({ err }, 'anti-confab audit error');
        confabAudit = null;
      }
    }

    let messages = updateFinalAssistantMessage(result.messages, guarded.output);
    if (prepared.classification?.risk === 'high') {
      messages = replaceLatestUserMessage(messages, prepared.sessionUserText);
    }
    const persistence = createInitialPersistence();
    if (prepared.blockedCapabilities.length > 0) {
      const inputBlocks = prepared.blockedCapabilities.filter(
        (code) =>
          code === 'recalled_memory_blocked' ||
          code === 'fetched_content_blocked' ||
          code === 'memory_recall' ||
          code === 'url_fetch' ||
          code === 'cognitive_prelude',
      );
      const policyBlocks = prepared.blockedCapabilities.filter(
        (code) =>
          code === 'memory_recall_surface_policy_blocked' ||
          code === 'url_fetch_surface_policy_blocked' ||
          code === 'cognitive_prelude_surface_policy_blocked',
      );
      recordInputBlock(persistence, ...inputBlocks);
      recordPolicyBlock(persistence, ...policyBlocks);
    }
    if (constrainedTools.blockedToolNames.length > 0) {
      recordPolicyBlock(persistence, 'tools_surface_policy_blocked');
    }
    if (highRisk) {
      recordPolicyBlock(persistence, 'tools_blocked');
      recordInputBlock(persistence, ...prepared.blockedCapabilities);
      recordWriteFailure(persistence, 'memory_store_blocked');
    }

    // Two-step gateway sanitize before reply hits surfaces / persistence:
    //   1. Strip <think>...</think> reasoning blocks (Telegram operator
    //      2026-05-04 caught these leaking into chat messages from
    //      cogito / qwen-thinking models).
    //   2. Append the "— via {provider}/{model}" stamp so the operator
    //      always knows which model generated the cleaned text.
    // Order matters: stamp goes on the cleaned body, not the raw one.
    // Truncation detection. When the provider reports finish_reason='length',
    // the model hit max_tokens before completing — operator's reply is
    // an incomplete tail. Surface a one-line note so a partial answer
    // isn't shipped as if it were the full thing. Operator session
    // 2026-05-05 caught HTML cut mid-stream; #494 raises the ceiling
    // when GEN_MAX_TOKENS is set, this is the second-line warning when
    // truncation still happens.
    const truncationNote =
      result.finishReason === 'length'
        ? '\n\n[response truncated by provider token limit; raise GEN_MAX_TOKENS or split the request to get the rest]'
        : '';

    const baseOutput = stripThinkBlocks(guarded.output, rawEnvWithTier3) + truncationNote;
    // Anti-confab Phase 2 splice: append the runtime warning footer (or
    // strip the offending sentences at Phase 3) BEFORE the provider
    // stamp so the operator-facing tail reads
    //   `[memphis: claim flagged …] — via anthropic/claude-sonnet-4-6`
    // rather than the other way around. Phase 1 / Phase 0 / null audit
    // pass through unchanged.
    const cleanedOutput =
      confabAudit !== null ? appendConfabWarning(baseOutput, confabAudit, confabPhase) : baseOutput;
    const stampedOutput = appendProviderStamp(
      cleanedOutput,
      llm.provider,
      llm.model,
      rawEnvWithTier3,
    );

    if (options.sendReply) {
      await options.sendReply(stampedOutput);
    }

    if (options.persistSession) {
      try {
        await options.persistSession({
          userText: prepared.sessionUserText,
          assistantReply: stampedOutput,
          messages,
        });
      } catch (error) {
        persistence.sessionUpdated = false;
        recordWriteFailure(persistence, error instanceof Error ? error.message : String(error));
      }
    }

    const trimmedMessages =
      Math.max(0, (options.messages ?? []).length - baseMessages.length) +
      contextGuard.trimmedMessages +
      contextGuard.truncatedMessages;
    const buildTurnTelemetrySnapshot = (): RuntimeTelemetry =>
      buildRuntimeTelemetry({
        provider: llm.provider,
        model: llm.model,
        systemPrompt: prepared.systemPrompt,
        messages: contextGuard.messages,
        usage: result.usage,
        trimmedMessages,
        compactionCount: conversationOverlay?.compactions?.length ?? 0,
        degraded: options.providerCascade?.degraded === true || persistence.degraded,
        degradationReason:
          options.providerCascade?.reason ??
          (persistence.errors.length > 0 ? persistence.errors[0] : undefined),
      });

    if (options.conversationContext && options.conversationId && persistence.sessionUpdated) {
      try {
        await options.conversationContext.refreshConversation({
          conversationId: options.conversationId,
          actorId: options.memoryUserId,
          sourceSurface: auditSurface,
          telemetry: buildTurnTelemetrySnapshot(),
        });
      } catch (error) {
        recordWriteFailure(persistence, error instanceof Error ? error.message : String(error));
      }
    }

    if (!surfacePolicy.allowMemoryWrite) {
      if (options.memory && options.memoryUserId && prepared.memoryUserText.trim().length > 0) {
        recordPolicyBlock(persistence, 'memory_store_surface_policy_blocked');
        await emitRuntimeSecurityEvent({
          action: 'surface_policy.memory_store.blocked',
          status: 'blocked',
          details: {
            surface: auditSurface,
            memoryUserId: options.memoryUserId,
          },
        });
      }
    } else if (
      options.memory &&
      options.memoryUserId &&
      prepared.memoryUserText.trim().length > 0
    ) {
      const memoryStoreScan = scanContent(`${prepared.memoryUserText}\n${cleanedOutput}`, 'memory');
      if (!memoryStoreScan.allowed) {
        recordWriteFailure(persistence, 'memory_store_scanned_blocked');
        await emitRuntimeSecurityEvent({
          action: 'content_scan.memory_store.blocked',
          status: 'blocked',
          details: {
            surface: options.auditSurface ?? options.surface,
            patternId: memoryStoreScan.patternId,
            reason: memoryStoreScan.reason,
            contentHash: memoryStoreScan.contentHash,
          },
        });
      } else {
        persistence.memoryStoreAttempted = true;
        try {
          // Pass turn + conversation ids so the trajectory exporter
          // can group per-turn events into multi-turn trajectories
          // (N8.2). Memory clients that don't plumb binding through
          // just ignore the extra argument (default MemoryClient.store
          // signature accepts it but defaults to undefined).
          await options.memory.store(
            options.memoryUserId,
            prepared.memoryUserText,
            cleanedOutput,
            {
              turnId,
              conversationId: options.conversationId,
            },
          );
          persistence.memoryStored = true;
        } catch (error) {
          recordWriteFailure(persistence, error instanceof Error ? error.message : String(error));
        }
      }
    }

    if (
      options.cognitiveRuntimeEnabled !== false &&
      prepared.originalUserText.trim().length > 0 &&
      prepared.classification?.risk !== 'high'
    ) {
      persistence.postResponseCognitiveAttempted = true;
      const postResponse = await runPostResponseCognitivePass({
        userText: prepared.originalUserText,
        assistantReply: cleanedOutput,
      });
      persistence.postResponseCognitiveOk = postResponse.ok;
      if (!postResponse.ok) {
        recordCognitiveFailure(persistence, postResponse.error);
      }

      try {
        const frame: Frame = {
          ts: Date.now(),
          surface: auditSurface,
          turnId,
          lastNTurns: extractFrameLastNTurns(messages, prepared.originalUserText, cleanedOutput),
          activeFilePaths: [],
          activeToolCalls: extractFrameToolCalls(messages),
        };
        pushFrame(frame);
      } catch (error) {
        log.warn({ err: error, turnId }, 'frame push failed');
      }
    }

    const telemetry = buildTurnTelemetrySnapshot();
    recordTurnTelemetry({
      surface: auditSurface,
      provider: llm.provider,
      model: llm.model,
      telemetry,
    });

    // Codex Round 5 P1 fix: record end-to-end turn latency for the SLO probe.
    // S2 operator decision 2026-05-12: turns that invoked memphis_repair
    // are written to the full-fidelity histogram but excluded from the
    // SLO-scoped one — a single repair call is 100k+ tokens in/out and
    // legitimately runs 2 minutes, which would otherwise dominate p99.
    const totalDurationMs = Date.now() - startedAt;
    const toolsCalledForSlo = extractToolsCalled(result.messages);
    const excludeFromSlo = toolsCalledForSlo.has('memphis_repair');
    metrics.recordTurnDuration(totalDurationMs, { excludeFromSlo });

    return {
      provider: llm.provider,
      model: llm.model,
      timingMs: totalDurationMs,
      output: guarded.output,
      messages,
      haltReason: result.haltReason,
      usage: result.usage,
      telemetry,
      persistence,
    };
  } finally {
    // Phase 2.2: release the admission slot — finally so even uncaught
    // exceptions free the slot for the next caller.
    admissionTicket.release();
  }
}
