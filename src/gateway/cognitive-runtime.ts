import { loadCognitiveConfig } from '../cognitive/config-loader.js';
import { ModelA_ConsciousCapture } from '../cognitive/model-a.js';
import { ModelB_InferredDecisions, type InferredDecision } from '../cognitive/model-b.js';
import { ModelC_PredictivePatterns } from '../cognitive/model-c.js';
import {
  loadCognitiveBlocks,
  shouldUseTestIsolatedCognitiveState,
} from '../cognitive/runtime-support.js';
import type { DecisionContext, Prediction } from '../cognitive/types.js';
import { LOG_LEVEL } from '../config/env-registry.js';
import { createPinoLogger } from '../infra/logging/pino.js';
import { searchExactMemory, type ExactSearchOutput } from '../infra/memory/exact-search.js';
import type { Block } from '../memory/chain.js';

const log = createPinoLogger({ level: LOG_LEVEL.read(process.env) });
const COGNITIVE_STOP_WORDS = new Set([
  'about',
  'again',
  'below',
  'could',
  'czemu',
  'gdzie',
  'jest',
  'jaki',
  'jakie',
  'jak',
  'ktory',
  'ktore',
  'ktora',
  'maybe',
  'over',
  'should',
  'that',
  'this',
  'through',
  'under',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
  'would',
]);

export interface CognitivePrelude {
  blocks: Block[];
  exact: ExactSearchOutput;
  inferred: InferredDecision[];
  predictions: Prediction[];
  promptFragment: string;
}

function extractQueryTags(input: string, blocks: Block[], exact: ExactSearchOutput): string[] {
  const tokens = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !COGNITIVE_STOP_WORDS.has(token));

  const tags = new Set(tokens);
  for (const hit of exact.hits.slice(0, 3)) {
    for (const tag of hit.tags.slice(0, 3)) {
      tags.add(tag);
    }
  }
  for (const block of blocks.slice(-12)) {
    for (const tag of block.data?.tags ?? []) {
      if (tags.size >= 8) break;
      tags.add(tag);
    }
  }

  return Array.from(tags).slice(0, 8);
}

function buildPredictionContext(
  input: string,
  blocks: Block[],
  exact: ExactSearchOutput,
): DecisionContext {
  const now = new Date();
  const recentDecisions = blocks.filter((block) => block.data?.type === 'decision').length;

  return {
    timeOfDay: now.getHours(),
    dayOfWeek: now.getDay(),
    recentDecisions,
    tags: extractQueryTags(input, blocks, exact),
    activity: input
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((token) => token.length >= 4)
      .slice(0, 6),
    chain: recentDecisions > 0 ? 'decisions' : 'journal',
  };
}

function summarizeExact(exact: ExactSearchOutput): string[] {
  return exact.hits
    .slice(0, 3)
    .map(
      (hit) =>
        `- ${hit.chain}#${hit.blockIndex} score=${hit.score.toFixed(2)} ${hit.summary.slice(0, 140)}`,
    );
}

function summarizeInferred(inferred: InferredDecision[]): string[] {
  return inferred
    .slice(0, 3)
    .map(
      (item) =>
        `- ${item.category} ${Math.round(item.confidence * 100)}% ${item.title} [${item.source}]`,
    );
}

function summarizePredictions(predictions: Prediction[]): string[] {
  return predictions
    .slice(0, 3)
    .map((item) => `- ${item.type} ${Math.round(item.confidence * 100)}% ${item.title}`);
}

function buildPromptFragment(parts: {
  exact: ExactSearchOutput;
  inferred: InferredDecision[];
  predictions: Prediction[];
}): string {
  const lines: string[] = [];
  const exactLines = summarizeExact(parts.exact);
  const inferredLines = summarizeInferred(parts.inferred);
  const predictionLines = summarizePredictions(parts.predictions);

  if (exactLines.length > 0) {
    lines.push('[chain_hits]');
    lines.push(...exactLines);
  }
  if (inferredLines.length > 0) {
    lines.push('[inferred_decisions]');
    lines.push(...inferredLines);
  }
  if (predictionLines.length > 0) {
    lines.push('[predictions]');
    lines.push(...predictionLines);
  }

  return lines.join('\n');
}

function buildSyntheticTurnBlocks(userText: string, assistantReply: string): Block[] {
  const now = Date.now();
  const userTimestamp = new Date(now).toISOString();
  const assistantTimestamp = new Date(now + 1).toISOString();

  return [
    {
      chain: 'journal',
      timestamp: userTimestamp,
      data: {
        type: 'ask',
        content: userText,
        tags: ['runtime', 'operator-turn'],
      },
    },
    {
      chain: 'journal',
      timestamp: assistantTimestamp,
      data: {
        type: 'journal',
        content: assistantReply,
        tags: ['runtime', 'assistant-turn'],
      },
    },
  ];
}

function shouldAutoCapture(content: string): boolean {
  return /(decision:|decided\s+to|we\s+will|i\s+will|milestone:|released?|shipped|completed|launched|finished)/i.test(
    content,
  );
}

export async function prepareCognitivePrelude(input: string): Promise<CognitivePrelude> {
  const cognitiveConfig = loadCognitiveConfig();
  if (shouldUseTestIsolatedCognitiveState(process.env)) {
    return {
      blocks: [],
      exact: { query: input, count: 0, hits: [] },
      inferred: [],
      predictions: [],
      promptFragment: '',
    };
  }

  const blocks = await loadCognitiveBlocks({}, process.env);
  const exact =
    input.trim().length > 0
      ? searchExactMemory(input, 3, process.env)
      : { query: '', count: 0, hits: [] };
  const inferred = new ModelB_InferredDecisions(cognitiveConfig.modelB)
    .inferFromChainHistory(blocks)
    .slice(0, 3);
  const predictions = new ModelC_PredictivePatterns(blocks, cognitiveConfig.modelC)
    .predict(buildPredictionContext(input, blocks, exact))
    .slice(0, 3);

  return {
    blocks,
    exact,
    inferred,
    predictions,
    promptFragment: buildPromptFragment({ exact, inferred, predictions }),
  };
}

export async function runPostResponseCognitivePass(input: {
  userText: string;
  assistantReply: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const cognitiveConfig = loadCognitiveConfig();
  if (shouldUseTestIsolatedCognitiveState(process.env)) {
    return { ok: true };
  }

  try {
    const blocks = await loadCognitiveBlocks({}, process.env);
    const augmented = [
      ...blocks,
      ...buildSyntheticTurnBlocks(input.userText, input.assistantReply),
    ];

    if (shouldAutoCapture(input.userText)) {
      await new ModelA_ConsciousCapture({
        ...cognitiveConfig.modelA,
        requireConfirmation: false,
      }).autoCapture({
        content: input.userText,
        tags: ['auto-capture', 'operator-turn'],
      });
    }

    if (shouldAutoCapture(input.assistantReply)) {
      await new ModelA_ConsciousCapture({
        ...cognitiveConfig.modelA,
        requireConfirmation: false,
      }).autoCapture({
        content: input.assistantReply,
        tags: ['auto-capture', 'assistant-turn'],
      });
    }

    const modelB = new ModelB_InferredDecisions(cognitiveConfig.modelB);
    const existingInferredIds = new Set(
      blocks
        .map((block) => block.data?.inferredId)
        .filter((value): value is string => typeof value === 'string'),
    );
    const freshInferred = modelB
      .inferFromChainHistory(augmented)
      .filter((decision) => !existingInferredIds.has(decision.id))
      .slice(0, 2);

    if (freshInferred.length > 0) {
      await modelB.persistDecisions(freshInferred);
    }

    await new ModelC_PredictivePatterns(augmented, cognitiveConfig.modelC).learn();
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, 'post-response cognitive pass failed');
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
