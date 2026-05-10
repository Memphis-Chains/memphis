import type { Frame } from './frame-buffer.js';
import type { InferredDecision } from './model-b.js';
import {
  COGNITIVE_MODES,
  getCognitiveModeConfig,
  type CognitiveMode,
  type CognitiveModeConfig,
} from './modes.js';
import type { Prediction } from './types.js';
import type { Block } from '../memory/chain.js';

export interface CognitiveModeDispatchInput {
  blocks?: Block[];
  inferred?: InferredDecision[];
  predictions?: Prediction[];
  frames?: Frame[];
}

export interface CognitiveModeContribution {
  mode: CognitiveMode;
  config: CognitiveModeConfig;
  temperature: number;
  maxTokens: number;
  promptFragment: string;
}

const STYLE_TO_MAX_TOKENS: Record<string, number> = {
  fast: 1024,
  deliberate: 4096,
  reflective: 4096,
  collaborative: 4096,
  meta: 2048,
};

const DEFAULT_MAX_TOKENS = 2048;

/**
 * Operator-overridable ceiling. When `GEN_MAX_TOKENS` is set in the
 * environment (.env or shell), the resolver USES THAT VALUE rather
 * than the per-style default. Operators producing long-form output
 * (HTML files, code drops, structured reports) need to raise the
 * ceiling without having to pick a different cognitive mode just to
 * unblock token budget. Operator session 2026-05-05 hit this — bot
 * was generating HTML in Mode B (deliberate, capped at 4096) and
 * the response truncated mid-stream while .env had
 * GEN_MAX_TOKENS=32768 that wasn't actually consumed anywhere.
 *
 * Per-model clamping is the responsibility of the provider adapter
 * (e.g. Anthropic adapter: Sonnet ≤64k, Opus/Haiku ≤32k). The schema
 * caps the env value at 1_048_576 as a sanity check
 * (`src/infra/config/schema.ts`). This resolver no longer applies a
 * second cap — pre-2026-05-10 it `Math.min(parsed, 32768)`'d every
 * env value, which silently clamped GEN_MAX_TOKENS=128000 (operator
 * setting for Anthropic Sonnet self-modify) back to 32k. The
 * adapter-side per-model clamp is the right enforcement boundary
 * because it knows which model the request is going to.
 *
 * Style defaults are still the floor when the env is unset.
 */
export function resolveMaxTokensForStyle(
  style: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): number {
  const envOverride = rawEnv.GEN_MAX_TOKENS?.trim();
  if (envOverride && envOverride.length > 0) {
    const parsed = Number(envOverride);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return STYLE_TO_MAX_TOKENS[style] ?? DEFAULT_MAX_TOKENS;
}

function isReflectionBlock(block: Block): boolean {
  if (block.chain !== 'reflections') return false;
  const kind = (block.data as { kind?: unknown })?.kind;
  return kind === 'reflection';
}

function isModelACaptureBlock(block: Block): boolean {
  const source = (block.data as { source?: unknown })?.source;
  return source === 'model-a';
}

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function formatFrameTimestamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return 'unknown';
  try {
    return new Date(ts).toISOString();
  } catch {
    return 'unknown';
  }
}

function formatFrameLine(frame: Frame): string {
  const parts: string[] = [`t=${formatFrameTimestamp(frame.ts)}`, `surface=${frame.surface}`];
  if (frame.activeToolCalls.length > 0) {
    parts.push(`tools=${frame.activeToolCalls.slice(0, 4).join(',')}`);
  }
  if (frame.activeFilePaths.length > 0) {
    parts.push(`files=${frame.activeFilePaths.slice(0, 3).join(',')}`);
  }
  const lastUser = [...frame.lastNTurns].reverse().find((turn) => turn.role === 'user');
  if (lastUser) {
    parts.push(`user="${truncate(lastUser.text, 120)}"`);
  }
  return `- ${parts.join(' ')}`;
}

function buildModeAFragment(blocks: Block[] | undefined, frames: Frame[] | undefined): string {
  const sections: string[] = [];

  const captures = (blocks ?? []).filter(isModelACaptureBlock).slice(-5);
  if (captures.length > 0) {
    const captureLines = captures.map((block) => {
      const data = block.data as { title?: string; content?: string; kind?: string };
      const title = data.title ?? data.content ?? '(untitled)';
      const kind = data.kind ?? 'note';
      return `- ${kind}: ${truncate(title, 140)}`;
    });
    sections.push(['[mode_A:recent_captures]', ...captureLines].join('\n'));
  }

  const recentFrames = (frames ?? []).slice(-5);
  if (recentFrames.length > 0) {
    const frameLines = recentFrames.map(formatFrameLine);
    sections.push(['[mode_A:recent_frames]', ...frameLines].join('\n'));
  }

  return sections.join('\n');
}

function buildModeBFragment(inferred: InferredDecision[] | undefined): string {
  if (!inferred || inferred.length === 0) return '';
  const top = inferred.slice(0, 3);
  const lines = top.map(
    (item) =>
      `- ${item.category} ${Math.round(item.confidence * 100)}% ${truncate(item.title, 120)} [${item.source}]`,
  );
  return ['[mode_B:inferred_decisions]', ...lines].join('\n');
}

function buildModeCFragment(predictions: Prediction[] | undefined): string {
  if (!predictions || predictions.length === 0) return '';
  const top = predictions.slice(0, 3);
  const lines = top.map(
    (item) => `- ${item.type} ${Math.round(item.confidence * 100)}% ${truncate(item.title, 120)}`,
  );
  return ['[mode_C:predicted_next_actions]', ...lines].join('\n');
}

function buildModeDFragment(rawEnv: NodeJS.ProcessEnv): string {
  const peers = rawEnv.MEMPHIS_COGNITIVE_PEERS?.trim();
  if (!peers) {
    return '[mode_D:collective] single-agent pass-through (MEMPHIS_COGNITIVE_PEERS unset)';
  }
  const peerList = peers
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return `[mode_D:collective] coordinating with ${peerList.length} peer(s): ${peerList.join(', ')}`;
}

function buildModeEFragment(blocks: Block[] | undefined): string {
  if (!blocks || blocks.length === 0) {
    return '[mode_E:reflection] no prior reflection available';
  }
  const reflections = blocks.filter(isReflectionBlock);
  if (reflections.length === 0) {
    return '[mode_E:reflection] no prior reflection available';
  }
  const latest = reflections[reflections.length - 1];
  const data = latest.data as { period?: string; content?: string; title?: string };
  const period = data.period ?? 'daily';
  const content = data.content ?? data.title ?? '';
  return `[mode_E:reflection:${period}] ${truncate(content, 280)}`;
}

export function applyCognitiveMode(
  mode: CognitiveMode,
  input: CognitiveModeDispatchInput = {},
  rawEnv: NodeJS.ProcessEnv = process.env,
): CognitiveModeContribution {
  const config = getCognitiveModeConfig(mode);
  const temperature = config.temperature;
  const maxTokens = resolveMaxTokensForStyle(config.style, rawEnv);

  let fragment = '';
  switch (mode) {
    case 'A':
      fragment = buildModeAFragment(input.blocks, input.frames);
      break;
    case 'B':
      fragment = buildModeBFragment(input.inferred);
      break;
    case 'C':
      fragment = buildModeCFragment(input.predictions);
      break;
    case 'D':
      fragment = buildModeDFragment(rawEnv);
      break;
    case 'E':
      fragment = buildModeEFragment(input.blocks);
      break;
    default:
      fragment = '';
  }

  return {
    mode,
    config,
    temperature,
    maxTokens,
    promptFragment: fragment,
  };
}

export function listCognitiveModes(): CognitiveMode[] {
  return Object.keys(COGNITIVE_MODES) as CognitiveMode[];
}
