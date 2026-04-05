import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  listBlockFiles,
  parseEnvelope,
  readBlockFile,
  withNapiAppendLock,
  writeBlockAtomic,
  type NapiBlock,
  type NapiBlockData,
} from './chain-file-io.js';
import {
  loadBridgeModule,
  resolveBridgeContract,
  type BridgeAliasMap,
  type BridgeResolution,
} from './napi-contract.js';
import { getChainPath, getReadableChainPaths, normalizeChainName } from '../../config/paths.js';
import { normalizeDecisionBlockData } from '../../core/decision-chain.js';
import { stableStringify } from '../../core/stable-stringify.js';
import type { Block } from '../../memory/chain.js';

export { withNapiAppendLock };

const CHAIN_BRIDGE_ALIASES = {
  chain_append: ['chain_append', 'chainAppend'],
  chain_validate: ['chain_validate', 'chainValidate'],
  chain_query: ['chain_query', 'chainQuery'],
  embed_store: ['embed_store', 'embedStore'],
  embed_search: ['embed_search', 'embedSearch'],
  soul_replay: ['soul_replay', 'soulReplay'],
  soul_loop_step: ['soul_loop_step', 'soulLoopStep'],
} satisfies BridgeAliasMap<
  | 'chain_append'
  | 'chain_validate'
  | 'chain_query'
  | 'embed_store'
  | 'embed_search'
  | 'soul_replay'
  | 'soul_loop_step'
>;

type ChainBridgeKey = keyof typeof CHAIN_BRIDGE_ALIASES;

interface ResolvedChainBridge {
  chain_append?: (chainJson: string, blockJson: string) => string;
  chain_validate?: (blockJson: string, prevJson?: string) => string;
  chain_query?: (chainJson: string, contains?: string, tag?: string) => string;
  embed_store?: (id: string, text: string) => string;
  embed_search?: (query: string, topK?: number) => string;
  soul_replay?: (chainName: string, blocksJson: string) => string;
  soul_loop_step?: (stateJson: string, actionJson: string, limitsJson?: string) => string;
}

interface CanonicalHashData {
  type: string;
  content: string;
  tags: string[];
}

interface SoulReplayBlockData {
  block_type: string;
  content: string;
  tags: string[];
}

export interface AppendBlockResult {
  index: number;
  hash: string;
  chain: string;
  timestamp: string;
}

export interface ValidateBlockResult {
  valid: boolean;
  errors?: string[];
}

export interface QueryBlocksResult {
  count: number;
  blocks: NapiBlock[];
}

export interface EmbedStoreResult {
  id: string;
  count: number;
  dim: number;
  provider: string;
}

export interface EmbedSearchHit {
  id: string;
  score: number;
  text_preview: string;
}

export interface EmbedSearchResult {
  query: string;
  count: number;
  hits: EmbedSearchHit[];
}

export interface SoulReplaySnapshot {
  blocks: number;
  last_hash: string | null;
  state_hash: string;
}

export interface SoulReplayResult {
  accepted: number;
  rejected: number;
  errors: string[];
  snapshot: SoulReplaySnapshot;
}

export type SoulLoopAction =
  | { type: 'tool_call'; data: { tool: string } }
  | { type: 'wait'; data: { duration_ms: number } }
  | { type: 'complete'; data: { summary: string } }
  | { type: 'error'; data: { recoverable: boolean; message: string } };

export interface SoulLoopLimits {
  max_steps: number;
  max_tool_calls: number;
  max_wait_ms: number;
  max_errors: number;
}

export interface SoulLoopState {
  steps: number;
  tool_calls: number;
  wait_ms: number;
  errors: number;
  completed: boolean;
  halt_reason: string | null;
}

export interface SoulLoopStepResult {
  applied: boolean;
  reason?: string;
  state: SoulLoopState;
}

function getBridgePath(rawEnv: NodeJS.ProcessEnv): string {
  return rawEnv.RUST_CHAIN_BRIDGE_PATH ?? './crates/memphis-napi';
}

function resolveChainBridge(
  rawEnv: NodeJS.ProcessEnv = process.env,
): BridgeResolution<ChainBridgeKey> {
  return resolveBridgeContract(loadBridgeModule(getBridgePath(rawEnv)), CHAIN_BRIDGE_ALIASES);
}

function normalizeData(data: Record<string, unknown>): NapiBlockData {
  const tags = Array.isArray(data.tags)
    ? data.tags.filter((v): v is string => typeof v === 'string')
    : [];

  const content = typeof data.content === 'string' ? data.content : JSON.stringify(data);

  const blockType = typeof data.type === 'string' ? data.type : 'journal';

  const passthrough = Object.fromEntries(
    Object.entries(data).filter(([key]) => !['type', 'content', 'tags'].includes(key)),
  );

  return {
    ...passthrough,
    type: blockType,
    content,
    tags,
  };
}

function toCanonicalHashData(data: NapiBlockData): CanonicalHashData {
  return {
    type: data.type,
    content: data.content,
    tags: [...data.tags],
  };
}

function toNapiBlock(
  chain: string,
  index: number,
  data: Record<string, unknown>,
  prevHash: string,
): NapiBlock {
  const normalizedChain = normalizeChainName(chain) ?? chain;
  const timestamp = new Date().toISOString();
  const normalized = normalizeData(data);
  const hashPayload = stableStringify({
    index,
    timestamp,
    chain: normalizedChain,
    data: toCanonicalHashData(normalized),
    prev_hash: prevHash,
  });

  return {
    index,
    timestamp,
    chain: normalizedChain,
    data: normalized,
    prev_hash: prevHash,
    hash: createHash('sha256').update(hashPayload).digest('hex'),
  };
}

function normalizeSoulReplayBlock(block: NapiBlock | { data: SoulReplayBlockData }): NapiBlock {
  const data = block.data as Record<string, unknown>;
  const blockType =
    typeof data.type === 'string'
      ? data.type
      : typeof data.block_type === 'string'
        ? data.block_type
        : 'journal';

  return {
    ...(block as NapiBlock),
    data: {
      ...(data as Record<string, unknown>),
      type: blockType,
    } as NapiBlockData,
  };
}

async function readChainBlocks(chain: string, rawEnv: NodeJS.ProcessEnv = process.env): Promise<NapiBlock[]> {
  const normalizedChain = normalizeChainName(chain) ?? chain;
  const blocks: NapiBlock[] = [];
  const seen = new Set<string>();

  for (const dir of getReadableChainPaths(normalizedChain, rawEnv)) {
    const files = await listBlockFiles(dir);
    // Parse errors and unexpected read errors must propagate — a corrupted block must
    // never be silently treated as "chain is empty" because the caller would then
    // regenerate a fresh genesis and overwrite existing blocks (see issue #70).
    const loaded = await Promise.all(files.map((file) => readBlockFile<NapiBlock>(join(dir, file))));

    for (const block of loaded) {
      const key = `${block.hash}:${block.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const normalizedData =
        normalizedChain === 'decisions' && block.data
          ? (normalizeDecisionBlockData(block.data as Record<string, unknown>) as NapiBlockData)
          : normalizeData((block.data ?? {}) as Record<string, unknown>);

      blocks.push({
        ...block,
        chain: normalizedChain,
        data: normalizedData,
      });
    }
  }

  return blocks.sort((a, b) => a.index - b.index);
}

async function writeBlock(chain: string, block: NapiBlock, rawEnv: NodeJS.ProcessEnv = process.env): Promise<void> {
  const normalizedChain = normalizeChainName(chain) ?? chain;
  const dir = getChainPath(normalizedChain, rawEnv);
  const payload = JSON.stringify({ ...block, chain: normalizedChain }, null, 2);
  await writeBlockAtomic(dir, block.index, payload);
}

export class NapiChainAdapter {
  private readonly bridge: BridgeResolution<ChainBridgeKey>;

  constructor(private readonly rawEnv: NodeJS.ProcessEnv = process.env) {
    this.bridge = resolveChainBridge(rawEnv);
  }

  private getBridgeOrThrow(): BridgeResolution<ChainBridgeKey> {
    if (!this.bridge.bridgeLoaded) {
      throw new Error('rust chain bridge unavailable');
    }
    return this.bridge;
  }

  async getRecentBlocks(chain = 'journal', limit = 20): Promise<Block[]> {
    const blocks = await readChainBlocks(chain, this.rawEnv);
    return blocks.slice(-Math.max(1, limit));
  }

  async appendBlock(chain: string, data: Record<string, unknown>): Promise<AppendBlockResult> {
    const normalizedChain = normalizeChainName(chain) ?? chain;
    const chainsDir = getChainPath(undefined, this.rawEnv);
    return withNapiAppendLock(chainsDir, async () => {
      const bridge = this.getBridgeOrThrow().resolved as ResolvedChainBridge;
      const appendFn = bridge.chain_append;
      if (typeof appendFn !== 'function') {
        throw new Error('chain_append not available in rust bridge');
      }

      const chainBlocks = await readChainBlocks(normalizedChain, this.rawEnv);
      const nextIndex = (chainBlocks.at(-1)?.index ?? 0) + 1;
      const prevHash = chainBlocks.at(-1)?.hash ?? '0'.repeat(64);
      const nextBlock = toNapiBlock(normalizedChain, nextIndex, data, prevHash);

      type AppendData = {
        appended: boolean;
        length: number;
        chain: NapiBlock[];
        errors?: string[];
      };
      const out = parseEnvelope<AppendData>(
        appendFn(JSON.stringify(chainBlocks), JSON.stringify(nextBlock)),
        'chain_append',
      );

      if (!out.appended) {
        throw new Error(
          `chain_append rejected block: ${(out.errors ?? []).join(', ') || 'unknown error'}`,
        );
      }

      const appended = out.chain.at(-1);
      if (!appended) {
        throw new Error('chain_append returned empty chain');
      }

      const persisted = {
        ...appended,
        data: {
          ...nextBlock.data,
          type: typeof appended.data?.type === 'string' ? appended.data.type : nextBlock.data.type,
          content:
            typeof appended.data?.content === 'string'
              ? appended.data.content
              : nextBlock.data.content,
          tags: Array.isArray(appended.data?.tags)
            ? appended.data.tags.filter((value): value is string => typeof value === 'string')
            : nextBlock.data.tags,
        },
      } satisfies NapiBlock;

      await writeBlock(normalizedChain, persisted, this.rawEnv);

      return {
        index: appended.index,
        hash: appended.hash,
        chain: normalizedChain,
        timestamp: appended.timestamp,
      };
    });
  }

  validateBlock(block: Block, prev?: Block): ValidateBlockResult {
    const bridge = this.getBridgeOrThrow().resolved as ResolvedChainBridge;
    const validateFn = bridge.chain_validate;
    if (typeof validateFn !== 'function') {
      throw new Error('chain_validate not available in rust bridge');
    }

    return parseEnvelope<ValidateBlockResult>(
      validateFn(JSON.stringify(block), prev ? JSON.stringify(prev) : undefined),
      'chain_validate',
    );
  }

  async queryBlocks(
    chain: string,
    options?: { contains?: string; tag?: string },
  ): Promise<QueryBlocksResult> {
    const bridge = this.getBridgeOrThrow().resolved as ResolvedChainBridge;
    const queryFn = bridge.chain_query;
    if (typeof queryFn !== 'function') {
      throw new Error('chain_query not available in rust bridge');
    }

    const chainBlocks = await readChainBlocks(chain, this.rawEnv);
    return parseEnvelope<QueryBlocksResult>(
      queryFn(JSON.stringify(chainBlocks), options?.contains, options?.tag),
      'chain_query',
    );
  }

  embedStore(id: string, text: string): EmbedStoreResult {
    const bridge = this.getBridgeOrThrow().resolved as ResolvedChainBridge;
    const storeFn = bridge.embed_store;
    if (typeof storeFn !== 'function') {
      throw new Error('embed_store not available in rust bridge');
    }

    return parseEnvelope<EmbedStoreResult>(storeFn(id, text), 'embed_store');
  }

  embedSearch(query: string, topK = 5): EmbedSearchResult {
    const bridge = this.getBridgeOrThrow().resolved as ResolvedChainBridge;
    const searchFn = bridge.embed_search;
    if (typeof searchFn !== 'function') {
      throw new Error('embed_search not available in rust bridge');
    }

    return parseEnvelope<EmbedSearchResult>(searchFn(query, topK), 'embed_search');
  }

  soulReplay(
    chainName: string,
    blocks: Array<NapiBlock | { data: SoulReplayBlockData }>,
  ): SoulReplayResult {
    const bridge = this.getBridgeOrThrow().resolved as ResolvedChainBridge;
    const replayFn = bridge.soul_replay;
    if (typeof replayFn !== 'function') {
      throw new Error('soul_replay not available in rust bridge');
    }

    const normalizedBlocks = blocks.map((block) => normalizeSoulReplayBlock(block));
    return parseEnvelope<SoulReplayResult>(
      replayFn(chainName, JSON.stringify(normalizedBlocks)),
      'soul_replay',
    );
  }

  soulLoopStep(
    state: SoulLoopState,
    action: SoulLoopAction,
    limits?: SoulLoopLimits,
  ): SoulLoopStepResult {
    const bridge = this.getBridgeOrThrow().resolved as ResolvedChainBridge;
    const loopFn = bridge.soul_loop_step;
    if (typeof loopFn !== 'function') {
      throw new Error('soul_loop_step not available in rust bridge');
    }

    return parseEnvelope<SoulLoopStepResult>(
      loopFn(
        JSON.stringify(state),
        JSON.stringify(action),
        limits ? JSON.stringify(limits) : undefined,
      ),
      'soul_loop_step',
    );
  }
}

export async function getRecentBlocks(
  chain = 'journal',
  limit = 20,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<Block[]> {
  const blocks = await readChainBlocks(chain, rawEnv);
  return blocks.slice(-Math.max(1, limit));
}

