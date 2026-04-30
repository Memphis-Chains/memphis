import { normalizeChainName } from '../config/paths.js';
import { normalizeDecisionBlockData } from '../core/decision-chain.js';
import { getRecentBlocks } from '../infra/storage/rust-chain-adapter.js';
import type { Block } from '../memory/chain.js';

export const DEFAULT_COGNITIVE_CHAIN_LIMITS = {
  cases: 40,
  decisions: 120,
  journal: 120,
  reflections: 80,
} as const;

export function shouldUseTestIsolatedCognitiveState(
  rawEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return rawEnv.NODE_ENV === 'test' && !rawEnv.MEMPHIS_DATA_DIR?.trim();
}

export function normalizeCognitiveBlock(block: Block): Block {
  const chain = normalizeChainName(block.chain ?? 'journal') ?? 'journal';
  const data =
    chain === 'decisions' && block.data ? normalizeDecisionBlockData(block.data) : block.data;

  return {
    ...block,
    chain,
    data,
  };
}

export async function loadCognitiveBlocks(
  limits: Partial<typeof DEFAULT_COGNITIVE_CHAIN_LIMITS> = {},
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<Block[]> {
  if (shouldUseTestIsolatedCognitiveState(rawEnv)) {
    return [];
  }
  const resolved = { ...DEFAULT_COGNITIVE_CHAIN_LIMITS, ...limits };
  const [journal, decisions, reflections, cases] = await Promise.all([
    getRecentBlocks('journal', resolved.journal, rawEnv),
    getRecentBlocks('decisions', resolved.decisions, rawEnv),
    getRecentBlocks('reflections', resolved.reflections, rawEnv),
    getRecentBlocks('cases', resolved.cases, rawEnv),
  ]);

  return [...journal, ...decisions, ...reflections, ...cases]
    .map((block) => normalizeCognitiveBlock(block))
    .sort((a, b) => {
      const ta = new Date(a.timestamp ?? 0).getTime();
      const tb = new Date(b.timestamp ?? 0).getTime();
      return ta - tb;
    });
}
