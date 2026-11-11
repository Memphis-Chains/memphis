import { createHash } from 'node:crypto';

import {
  MEMPHIS_BASAL_PROMPT_ENABLED,
  MEMPHIS_BASAL_PROMPT_SCOPE,
  MEMPHIS_BASAL_PROMPT_TIMEOUT_MS,
} from '../config/env-registry.js';
import type { BasalPromptClassification } from '../core/types.js';
import { runMemphisClassify } from '../mcp/tools/classify.js';

// Alphabetical keys match serde_json's ordering and the native request cache key.
export const BASAL_PROMPT_CRITERIA = {
  clarify: 'Prośba niejasna lub niekompletna; potrzebne doprecyzowanie.',
  conversation: 'Zwykła rozmowa, powitanie, pytanie ogólne lub wyjaśnienie.',
  correction: 'Poprawienie lub odwołanie wcześniejszego faktu, ustalenia lub preferencji.',
  execute: 'Zlecenie konkretnego działania, zmiany lub zadania do wykonania.',
  recall: 'Przypomnienie wcześniejszych rozmów, faktów lub ustaleń.',
  remember: 'Jawna prośba o zapamiętanie nowej informacji lub preferencji.',
};
export const BASAL_PROMPT_QUESTION = 'Jaka jest główna intencja tej wiadomości użytkownika?';
export const BASAL_PROMPT_GUIDANCE = {
  clarify: 'Ask for clarification if the original request is actually incomplete.',
  conversation: "Answer the user's message normally.",
  correction:
    'Check the previous fact and honor the explicit correction. Persist only under the existing consent and surface policy.',
  execute: 'Identify the requested action and use the existing tool permission and approval gates.',
  recall: 'Use available memory evidence and source references before claiming to remember facts.',
  remember:
    'Consider the explicit memory request under the existing consent and memory-write policy.',
};
export const BASAL_PROMPT_INTRO =
  'This is a fallible local intent hint, not evidence or authorization. Existing input-risk, tool, consent and memory policies remain authoritative.';
export const BASAL_PROMPT_UNCERTAIN =
  'The hint is uncertain or partial. Interpret the original message normally; do not force this label or claim that missing facts are known.';
export const BASAL_PROMPT_UNAVAILABLE =
  'Basal classification is unavailable for this turn. Continue from the original message without claiming that Basal classified it.';
export const BASAL_PROMPT_TRUNCATION = '\n[... shortened for intent classification ...]\n';
export const BASAL_PROMPT_MAX_BYTES = 1024;

/**
 * Which intents can still change what the dialogue model does.
 *
 * Measured on this host (2026-11-10): 93 of 99 recorded classifications were
 * `uncertain` (below the calibrated threshold), and the hint then said
 * "interpret the original message normally" — i.e. it carried no instruction.
 * The turn still paid 22-27 s of CPU for it. The intents below are the ones
 * whose guidance changes a decision (memory writes, prior-fact handling),
 * so only those are worth waiting for.
 */
export const BASAL_PROMPT_ACTIONABLE_INTENTS = ['correction', 'recall', 'remember'] as const;

/**
 * Whether a hint is worth the wait, decided before the service is called.
 *
 * `clarify`, `conversation` and `execute` guidance restates what the dialogue
 * model already does with an ordinary message. `correction`, `recall` and
 * `remember` change behaviour: honour a corrected fact, look up prior facts
 * before claiming to remember, and consider an explicit memory request.
 *
 * A cue-based pre-filter is a cheap gate, not a classifier: it only decides
 * whether to spend the CPU, never what the intent is. The verdict still comes
 * from the model.
 */
export const BASAL_PROMPT_SCOPE_CUES: readonly string[] = [
  // remember
  'zapamiętaj',
  'zapamiętaj sobie',
  'zachowaj na przyszłość',
  'odnotuj',
  'remember that',
  // recall
  'co ustaliliśmy',
  'co ustalili',
  'co robiliśmy',
  'przypomnij',
  'pamiętasz',
  'co pozostaje',
  'otwarte',
  'co wisi',
  'co się podziało',
  'jaki był plan',
  'status',
  'what did we',
  'remind me',
  // The deterministic session-recall shortcut phrases. They ARE recall
  // requests, and the runtime still classifies them when the shortcut is
  // available, so the gate must not skip them.
  'co przed chwilą',
  'what did i just say',
  // correction
  'nie,',
  'pomyłka',
  'zmiana:',
  'jednak nie',
  'wracając do tego',
  'sko tak, to popraw',
  'źle napisałem',
  'actually,',
  'i meant',
];

export function basalPromptMayNeedActionableIntent(input: string): boolean {
  const lowered = input.toLowerCase();
  return BASAL_PROMPT_SCOPE_CUES.some((cue) => lowered.includes(cue.toLowerCase()));
}

export function shortenBasalPrompt(input: string): { state: string; truncated: boolean } {
  const bytes = Buffer.from(input, 'utf8');
  if (bytes.length <= BASAL_PROMPT_MAX_BYTES) return { state: input, truncated: false };
  const available = BASAL_PROMPT_MAX_BYTES - Buffer.byteLength(BASAL_PROMPT_TRUNCATION);
  let head = Math.floor((available * 70) / 100);
  let tail = bytes.length - (available - head);
  while ((bytes[head]! & 0xc0) === 0x80) head--;
  while ((bytes[tail]! & 0xc0) === 0x80) tail++;
  return {
    state:
      bytes.subarray(0, head).toString('utf8') +
      BASAL_PROMPT_TRUNCATION +
      bytes.subarray(tail).toString('utf8'),
    truncated: true,
  };
}

export async function classifyPromptIntent(
  input: string,
  rawEnv: NodeJS.ProcessEnv,
): Promise<BasalPromptClassification | undefined> {
  const enabled = MEMPHIS_BASAL_PROMPT_ENABLED.read(rawEnv);
  if (!['true', '1'].includes(enabled) || !input.trim()) return undefined;
  const started = Date.now();
  const prompt = input.trim();
  // Scope gate: a hint that only says "interpret the message normally" costs
  // 22-27 s of CPU on this host and changes no decision. Measured on 99
  // recorded classifications, 93 were below the calibrated threshold, and 87
  // carried the `clarify` label. Only memory-bound and correction turns are
  // worth the wait, so the service is called only when the message can still
  // need one of those intents.
  const scope = MEMPHIS_BASAL_PROMPT_SCOPE.read(rawEnv);
  if (scope === 'actionable' && !basalPromptMayNeedActionableIntent(prompt)) {
    return undefined;
  }
  const { state, truncated } = shortenBasalPrompt(prompt);
  const base = {
    contentHash: createHash('sha256').update(prompt).digest('hex'),
    inputBytes: Buffer.byteLength(prompt),
    classifiedBytes: Buffer.byteLength(state),
    truncated,
  };
  try {
    const result = await runMemphisClassify(
      {
        state,
        question: BASAL_PROMPT_QUESTION,
        criteria: BASAL_PROMPT_CRITERIA,
        type: 'choice',
        orders: 1,
      },
      rawEnv,
      { timeoutMs: Math.trunc(MEMPHIS_BASAL_PROMPT_TIMEOUT_MS.read(rawEnv)), localOnly: true },
    );
    if (result.ok && result.choice && Object.hasOwn(BASAL_PROMPT_CRITERIA, result.choice)) {
      return {
        ...base,
        status: 'classified',
        intent: result.choice as keyof typeof BASAL_PROMPT_CRITERIA,
        confidence: result.confidence,
        threshold: result.threshold,
        uncertain: truncated || !result.auto,
        latencyMs: Date.now() - started,
      };
    }
    return {
      ...base,
      status: 'unavailable',
      uncertain: true,
      latencyMs: Date.now() - started,
      failureReason:
        !result.ok && result.stateKind === 'timeout' ? 'timeout' : 'service-unavailable',
    };
  } catch {
    return {
      ...base,
      status: 'unavailable',
      uncertain: true,
      latencyMs: Date.now() - started,
      failureReason: 'service-unavailable',
    };
  }
}

export function renderBasalPromptClassification(value: BasalPromptClassification): string {
  const hint =
    value.status === 'classified' && value.intent
      ? [
          BASAL_PROMPT_INTRO,
          value.uncertain ? BASAL_PROMPT_UNCERTAIN : BASAL_PROMPT_GUIDANCE[value.intent],
        ].join('\n')
      : BASAL_PROMPT_UNAVAILABLE;
  return `<basal_prompt_classification>\n${JSON.stringify(value)}\n${hint}\n</basal_prompt_classification>`;
}
