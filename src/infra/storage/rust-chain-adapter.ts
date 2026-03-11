import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { getChainPath } from '../../config/paths.js';
import type { Block } from '../../memory/chain.js';

interface BridgeEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface RustBridgeLike {
  chain_append?: (chainJson: string, blockJson: string) => string;
  chain_validate?: (blockJson: string, prevJson?: string) => string;
  chain_query?: (chainJson: string, contains?: string, tag?: string) => string;
  chainAppend?: (chainJson: string, blockJson: string) => string;
  chainValidate?: (blockJson: string, prevJson?: string) => string;
  chainQuery?: (chainJson: string, contains?: string, tag?: string) => string;
  embed_store?: (id: string, text: string) => string;
  embed_search?: (query: string, topK?: number) => string;
  embedStore?: (id: string, text: string) => string;
  embedSearch?: (query: string, topK?: number) => string;
}

interface NapiBlockData {
  block_type: string;
  content: string;
  tags: string[];
  [key: string]: unknown;
}

interface NapiBlock {
  index: number;
  timestamp: string;
  chain: string;
  data: NapiBlockData;
  prev_hash: string;
  hash: string;
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

function loadBridge(path: string): RustBridgeLike | null {
  try {
    const req = createRequire(`${process.cwd()}/`);
    return req(path) as RustBridgeLike;
  } catch {
    return null;
  }
}

function normalizeData(data: Record<string, unknown>): NapiBlockData {
  const tags = Array.isArray(data.tags)
    ? data.tags.filter((v): v is string => typeof v === 'string')
    : [];

  const content = typeof data.content === 'string' ? data.content : JSON.stringify(data);

  const blockType = typeof data.type === 'string' ? data.type : 'journal';

  return {
    block_type: blockType,
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
  const hashInput = `${index}|${timestamp}|${chain}|${normalized.block_type}|${normalized.content}|${normalized.tags.join(',')}|${prevHash}`;

  return {
    index,
    timestamp,
    chain,
    data: normalized,
    prev_hash: prevHash,
    hash: createHash('sha256').update(hashInput).digest('hex'),
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
  private readonly bridge: RustBridgeLike | null;

  constructor(private readonly rawEnv: NodeJS.ProcessEnv = process.env) {
    this.bridge = loadBridge(getBridgePath(rawEnv));
  }

  private getBridgeOrThrow(): RustBridgeLike {
    if (!this.bridge) {
      throw new Error('rust chain bridge unavailable');
    }
    return this.bridge;
  }

  async getRecentBlocks(chain = 'journal', limit = 20): Promise<Block[]> {
    const blocks = await readChainBlocks(chain);
    return blocks.slice(-Math.max(1, limit));
  }

  async appendBlock(chain: string, data: Record<string, unknown>): Promise<AppendBlockResult> {
    const bridge = this.getBridgeOrThrow();
    const appendFn = bridge.chain_append ?? bridge.chainAppend;
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
    const bridge = this.getBridgeOrThrow();
    const validateFn = bridge.chain_validate ?? bridge.chainValidate;
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
    const bridge = this.getBridgeOrThrow();
    const queryFn = bridge.chain_query ?? bridge.chainQuery;
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
    const bridge = this.getBridgeOrThrow();
    const storeFn = bridge.embed_store ?? bridge.embedStore;
    if (typeof storeFn !== 'function') {
      throw new Error('embed_store not available in rust bridge');
    }

    return parseEnvelope<EmbedStoreResult>(storeFn(id, text), 'embed_store');
  }

  embedSearch(query: string, topK = 5): EmbedSearchResult {
    const bridge = this.getBridgeOrThrow();
    const searchFn = bridge.embed_search ?? bridge.embedSearch;
    if (typeof searchFn !== 'function') {
      throw new Error('embed_search not available in rust bridge');
    }

    return parseEnvelope<EmbedSearchResult>(searchFn(query, topK), 'embed_search');
  }
}

export async function getRecentBlocks(chain = 'journal', limit = 20): Promise<Block[]> {
  const blocks = await readChainBlocks(chain);
  return blocks.slice(-Math.max(1, limit));
}
