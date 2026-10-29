import { createHash } from 'node:crypto';

import {
  MEMPHIS_BASAL_PROMPT_ENABLED,
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
