/* eslint-disable no-restricted-syntax */
//
// Decision history store — same dynamic process.env write pattern as
// runtime-repair (env-rollback during transactional decision writes).
// Keys aren't statically known. File-level disable.
//
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { decisionBlockDataFromRecord, decisionRecordFromBlock } from './decision-chain.js';
import type { DecisionRecord } from './decision-lifecycle.js';
import { indexExactSearchBlock } from '../infra/memory/exact-search.js';
import { appendBlock, type AppendBlockResult } from '../infra/storage/chain-adapter.js';
import { getRecentBlocks } from '../infra/storage/rust-chain-adapter.js';

export type DecisionHistoryEntry = {
  ts: string;
  decision: DecisionRecord;
  correlationId?: string;
  chainRef?: {
    chain: string;
    index: number;
    hash: string;
  };
};

export type DecisionChainAppender = (
  chain: string,
  data: Record<string, unknown>,
  rawEnv?: NodeJS.ProcessEnv,
) => Promise<AppendBlockResult>;

export type RecordDecisionHistoryOptions = {
  source?: string;
  fallbackTags?: string[];
  correlationId?: string;
  extraData?: Record<string, unknown>;
  rawEnv?: NodeJS.ProcessEnv;
  mirrorPath?: string;
  mirrorJsonl?: boolean;
};

export type RecordDecisionHistoryDeps = {
  append?: DecisionChainAppender;
  indexExact?: typeof indexExactSearchBlock | null;
  appendMirror?: typeof appendDecisionHistory;
};

export function decisionHistoryPath(path = 'data/decision-history.jsonl'): string {
  return resolve(path);
}

export function appendDecisionHistory(
  decision: DecisionRecord,
  options?: {
    path?: string;
    chainRef?: DecisionHistoryEntry['chainRef'];
    correlationId?: string;
  },
): string {
  const target = decisionHistoryPath(options?.path);
  mkdirSync(dirname(target), { recursive: true });
  const entry: DecisionHistoryEntry = {
    ts: new Date().toISOString(),
    decision,
    correlationId: options?.correlationId,
    chainRef: options?.chainRef,
  };
  appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8');
  return target;
}

export async function recordDecisionHistoryEntry(
  decision: DecisionRecord,
  options: RecordDecisionHistoryOptions = {},
  deps: RecordDecisionHistoryDeps = {},
): Promise<DecisionHistoryEntry> {
  const rawEnv = options.rawEnv ?? process.env;
  const payload = decisionBlockDataFromRecord(decision, {
    source: options.source,
    fallbackTags: options.fallbackTags,
    correlationId: options.correlationId,
    extraData: options.extraData,
  });
  const append = deps.append ?? appendBlock;
  const indexExact = deps.indexExact === null ? null : (deps.indexExact ?? indexExactSearchBlock);
  const block = await append('decisions', payload, rawEnv);

  try {
    indexExact?.(
      {
        chain: block.chain,
        index: block.index,
        hash: block.hash,
        data: payload,
      },
      rawEnv,
    );
  } catch {
    // Exact search remains rebuildable from chain source data.
  }

  const entry: DecisionHistoryEntry = {
    ts: block.timestamp,
    decision,
    correlationId: options.correlationId,
    chainRef: {
      chain: block.chain,
      index: block.index,
      hash: block.hash,
    },
  };

  if (options.mirrorJsonl || options.mirrorPath) {
    (deps.appendMirror ?? appendDecisionHistory)(decision, {
      path: options.mirrorPath,
      correlationId: options.correlationId,
      chainRef: entry.chainRef,
    });
  }

  return entry;
}

export function readDecisionHistory(path?: string): DecisionHistoryEntry[] {
  const target = decisionHistoryPath(path);
  if (!existsSync(target)) return [];
  return readFileSync(target, 'utf8')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DecisionHistoryEntry);
}

async function withScopedEnv<T>(
  rawEnv: NodeJS.ProcessEnv | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!rawEnv) return fn();

  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(rawEnv)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export async function readDecisionHistoryFromChains(
  rawEnv?: NodeJS.ProcessEnv,
): Promise<DecisionHistoryEntry[]> {
  const blocks = await withScopedEnv(rawEnv, () => getRecentBlocks('decisions', 10_000));
  const entries = blocks
    .map((block) => {
      const decision = decisionRecordFromBlock(block);
      if (!decision) return null;
      return {
        ts: block.timestamp ?? decision.updatedAt,
        decision,
        correlationId:
          typeof block.data?.correlationId === 'string' ? block.data.correlationId : undefined,
        chainRef:
          typeof block.index === 'number' && typeof block.hash === 'string'
            ? {
                chain: block.chain ?? 'decisions',
                index: block.index,
                hash: block.hash,
              }
            : undefined,
      } satisfies DecisionHistoryEntry;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return entries.sort((a, b) => a.ts.localeCompare(b.ts));
}

export async function readCanonicalDecisionHistory(options?: {
  path?: string;
  rawEnv?: NodeJS.ProcessEnv;
}): Promise<DecisionHistoryEntry[]> {
  if (options?.path) {
    return readDecisionHistory(options.path);
  }
  return readDecisionHistoryFromChains(options?.rawEnv);
}
