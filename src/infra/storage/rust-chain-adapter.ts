import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  loadBridgeModule,
  resolveBridgeContract,
  type BridgeAliasMap,
  type BridgeResolution,
} from './napi-contract.js';
import { getChainPath } from '../../config/paths.js';
import type { Block } from '../../memory/chain.js';

interface BridgeEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

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

interface NapiBlockData {
  type: string;
  content: string;
  tags: string[];
  [key: string]: unknown;
}

interface SoulReplayBlockData {
  block_type: string;
  content: string;
  tags: string[];
}

interface NapiBlock {
  index: number;
  timestamp: string;
  chain: string;
  data: NapiBlockData;
  prev_hash: string;
  hash: string;
  signer?: string;
  signature?: string;
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

function parseEnvelope<T>(raw: string, fnName: string): T {
  let out: BridgeEnvelope<T>;
  try {
    out = JSON.parse(raw) as BridgeEnvelope<T>;
  } catch (error) {
    throw new Error(`${fnName}: invalid JSON response (${String(error)})`, { cause: error });
  }

  if (!out.ok) {
    throw new Error(`${fnName}: ${out.error ?? 'bridge returned error'}`);
  }

  if (out.data === undefined) {
    throw new Error(`${fnName}: bridge returned empty data`);
  }

  return out.data;
}

function getBridgePath(rawEnv: NodeJS.ProcessEnv): string {
  return rawEnv.RUST_CHAIN_BRIDGE_PATH ?? './crates/memphis-napi';
}

function resolveChainBridge(rawEnv: NodeJS.ProcessEnv = process.env): BridgeResolution<ChainBridgeKey> {
  return resolveBridgeContract(loadBridgeModule(getBridgePath(rawEnv)), CHAIN_BRIDGE_ALIASES);
}

function normalizeData(data: Record<string, unknown>): NapiBlockData {
  const tags = Array.isArray(data.tags)
    ? data.tags.filter((v): v is string => typeof v === 'string')
    : [];

  const content = typeof data.content === 'string' ? data.content : JSON.stringify(data);

  const blockType = typeof data.type === 'string' ? data.type : 'journal';

  return {
    type: blockType,
    content,
    tags,
  };
}

function toNapiBlock(
  chain: string,
  index: number,
  data: Record<string, unknown>,
  prevHash: string,
): NapiBlock {
  const timestamp = new Date().toISOString();
  const normalized = normalizeData(data);
  const hashPayload = stableStringify({
    index,
    timestamp,
    chain,
    data: normalized,
    prev_hash: prevHash,
  });

  return {
    index,
    timestamp,
    chain,
    data: normalized,
    prev_hash: prevHash,
    hash: createHash('sha256').update(hashPayload).digest('hex'),
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return Object.fromEntries(entries.map(([key, nested]) => [key, sortValue(nested)]));
  }

  return value;
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

async function readChainBlocks(chain: string): Promise<NapiBlock[]> {
  const dir = getChainPath(chain);
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();

    const blocks = await Promise.all(
      files.map(async (file) => {
        const raw = await readFile(join(dir, file), 'utf8');
        return JSON.parse(raw) as NapiBlock;
      }),
    );

    return blocks;
  } catch {
    return [];
  }
}

async function writeBlock(chain: string, block: NapiBlock): Promise<void> {
  const dir = getChainPath(chain);
  await mkdir(dir, { recursive: true });
  const filename = join(dir, `${String(block.index).padStart(6, '0')}.json`);
  await writeFile(filename, JSON.stringify(block, null, 2), 'utf8');
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
    const blocks = await readChainBlocks(chain);
    return blocks.slice(-Math.max(1, limit));
  }

  async appendBlock(chain: string, data: Record<string, unknown>): Promise<AppendBlockResult> {
    const bridge = this.getBridgeOrThrow().resolved as ResolvedChainBridge;
    const appendFn = bridge.chain_append;
    if (typeof appendFn !== 'function') {
      throw new Error('chain_append not available in rust bridge');
    }

    const chainBlocks = await readChainBlocks(chain);
    const nextIndex = (chainBlocks.at(-1)?.index ?? 0) + 1;
    const prevHash = chainBlocks.at(-1)?.hash ?? '0'.repeat(64);
    const nextBlock = toNapiBlock(chain, nextIndex, data, prevHash);

    type AppendData = { appended: boolean; length: number; chain: NapiBlock[]; errors?: string[] };
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

    await writeBlock(chain, appended);

    return {
      index: appended.index,
      hash: appended.hash,
      chain: appended.chain,
      timestamp: appended.timestamp,
    };
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

    const chainBlocks = await readChainBlocks(chain);
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

export async function getRecentBlocks(chain = 'journal', limit = 20): Promise<Block[]> {
  const blocks = await readChainBlocks(chain);
  return blocks.slice(-Math.max(1, limit));
}
