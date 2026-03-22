import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  loadBridgeModule,
  resolveBridgeContract,
  type BridgeAliasMap,
  type BridgeResolution,
} from './napi-contract.js';
import { getChainPath, getDataDir } from '../../config/paths.js';
import { stableStringify } from '../../core/stable-stringify.js';
import type {
  CaseAppendResult,
  CaseEntry,
  CaseIndexRow,
  CaseQuery,
  CaseQueryResult,
  CaseRebuildReport,
} from '../../memory/case-types.js';

interface BridgeEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

const CASE_BRIDGE_ALIASES = {
  case_append: ['case_append', 'caseAppend'],
  case_query: ['case_query', 'caseQuery'],
  case_rebuild: ['case_rebuild', 'caseRebuild'],
} satisfies BridgeAliasMap<'case_append' | 'case_query' | 'case_rebuild'>;

type CaseBridgeKey = keyof typeof CASE_BRIDGE_ALIASES;

interface ResolvedCaseBridge {
  case_append?: (chainJson: string, entryJson: string, indexDbPath: string) => string;
  case_query?: (queryJson: string, indexDbPath: string) => string;
  case_rebuild?: (blocksJson: string, indexDbPath: string) => string;
}

interface NapiBlockData {
  type: string;
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
  signer?: string;
  signature?: string;
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

function resolveCaseBridge(
  rawEnv: NodeJS.ProcessEnv = process.env,
): BridgeResolution<CaseBridgeKey> {
  return resolveBridgeContract(loadBridgeModule(getBridgePath(rawEnv)), CASE_BRIDGE_ALIASES);
}

function getIndexDbPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return join(getDataDir(rawEnv), 'case-index.sqlite');
}

const CHAIN_NAME = 'cases';

async function readChainBlocks(
  chain: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<NapiBlock[]> {
  const dir = getChainPath(chain, rawEnv);
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

async function writeBlock(
  chain: string,
  block: NapiBlock,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dir = getChainPath(chain, rawEnv);
  await mkdir(dir, { recursive: true });
  const filename = join(dir, `${String(block.index).padStart(6, '0')}.json`);
  await writeFile(filename, JSON.stringify(block, null, 2), 'utf8');
}

function toNapiBlock(
  chain: string,
  index: number,
  data: NapiBlockData,
  prevHash: string,
): NapiBlock {
  const timestamp = new Date().toISOString();
  const hashPayload = stableStringify({
    index,
    timestamp,
    chain,
    data,
    prev_hash: prevHash,
  });

  return {
    index,
    timestamp,
    chain,
    data,
    prev_hash: prevHash,
    hash: createHash('sha256').update(hashPayload).digest('hex'),
  };
}

export class CaseChainAdapter {
  private readonly bridge: BridgeResolution<CaseBridgeKey>;
  private readonly rawEnv: NodeJS.ProcessEnv;

  constructor(rawEnv: NodeJS.ProcessEnv = process.env) {
    this.rawEnv = rawEnv;
    this.bridge = resolveCaseBridge(rawEnv);
  }

  private get rustAvailable(): boolean {
    return (
      this.bridge.bridgeLoaded &&
      typeof (this.bridge.resolved as ResolvedCaseBridge).case_append === 'function'
    );
  }

  async appendCaseEntry(entry: CaseEntry): Promise<CaseAppendResult> {
    if (this.rustAvailable) {
      return this.appendViaRust(entry);
    }
    return this.appendViaTs(entry);
  }

  async queryCases(query: CaseQuery): Promise<CaseQueryResult> {
    if (this.rustAvailable) {
      return this.queryViaRust(query);
    }
    return this.queryViaTs(query);
  }

  async rebuildIndex(): Promise<CaseRebuildReport> {
    if (this.rustAvailable) {
      return this.rebuildViaRust();
    }
    return { indexed: 0, errors: 0 };
  }

  private async appendViaRust(entry: CaseEntry): Promise<CaseAppendResult> {
    const bridge = this.bridge.resolved as ResolvedCaseBridge;
    const appendFn = bridge.case_append!;

    const chainBlocks = await readChainBlocks(CHAIN_NAME, this.rawEnv);
    const chainJson = JSON.stringify(chainBlocks);
    const entryJson = JSON.stringify(entry);
    const indexDbPath = getIndexDbPath(this.rawEnv);

    const raw = appendFn(chainJson, entryJson, indexDbPath);

    type AppendData = {
      appended: boolean;
      block: NapiBlock;
      errors?: string[];
    };
    const out = parseEnvelope<AppendData>(raw, 'case_append');

    if (!out.appended) {
      throw new Error(
        `case_append rejected entry: ${(out.errors ?? []).join(', ') || 'unknown error'}`,
      );
    }

    await writeBlock(CHAIN_NAME, out.block, this.rawEnv);

    return {
      success: true,
      index: out.block.index,
      hash: out.block.hash,
      chain: CHAIN_NAME,
      timestamp: out.block.timestamp,
      case_type: entry.case_type,
    };
  }

  private async appendViaTs(entry: CaseEntry): Promise<CaseAppendResult> {
    const chainBlocks = await readChainBlocks(CHAIN_NAME, this.rawEnv);
    const nextIndex = (chainBlocks.at(-1)?.index ?? 0) + 1;
    const prevHash = chainBlocks.at(-1)?.hash ?? '0'.repeat(64);

    const caseTag = `case:${entry.case_type}`;
    const data: NapiBlockData = {
      type: 'case',
      content: JSON.stringify(entry),
      tags: [caseTag],
    };

    const block = toNapiBlock(CHAIN_NAME, nextIndex, data, prevHash);
    await writeBlock(CHAIN_NAME, block, this.rawEnv);

    return {
      success: true,
      index: block.index,
      hash: block.hash,
      chain: CHAIN_NAME,
      timestamp: block.timestamp,
      case_type: entry.case_type,
    };
  }

  private async queryViaRust(query: CaseQuery): Promise<CaseQueryResult> {
    const bridge = this.bridge.resolved as ResolvedCaseBridge;
    const queryFn = bridge.case_query!;
    const indexDbPath = getIndexDbPath(this.rawEnv);

    const raw = queryFn(JSON.stringify(query), indexDbPath);
    return parseEnvelope<CaseQueryResult>(raw, 'case_query');
  }

  private async queryViaTs(query: CaseQuery): Promise<CaseQueryResult> {
    const chainBlocks = await readChainBlocks(CHAIN_NAME, this.rawEnv);
    const entries: CaseIndexRow[] = [];

    // Scan blocks in reverse (most recent first)
    for (let i = chainBlocks.length - 1; i >= 0; i--) {
      const block = chainBlocks[i]!;
      if (block.data.type !== 'case') continue;

      try {
        const parsed = JSON.parse(block.data.content) as CaseEntry;
        if (!matchesQuery(parsed, query)) continue;

        entries.push({
          block_index: block.index,
          block_hash: block.hash,
          chain: CHAIN_NAME,
          case_type: parsed.case_type,
          full_json: block.data.content,
          indexed_at: new Date().toISOString(),
          ...extractFields(parsed),
        });

        if (query.limit && entries.length >= query.limit) break;
      } catch {
        // skip malformed entries
      }
    }

    return { count: entries.length, entries };
  }

  private async rebuildViaRust(): Promise<CaseRebuildReport> {
    const bridge = this.bridge.resolved as ResolvedCaseBridge;
    const rebuildFn = bridge.case_rebuild!;

    const chainBlocks = await readChainBlocks(CHAIN_NAME, this.rawEnv);
    const indexDbPath = getIndexDbPath(this.rawEnv);

    const raw = rebuildFn(JSON.stringify(chainBlocks), indexDbPath);
    return parseEnvelope<CaseRebuildReport>(raw, 'case_rebuild');
  }
}

function matchesQuery(entry: CaseEntry, query: CaseQuery): boolean {
  if (query.case_type && entry.case_type !== query.case_type) return false;

  const fields = extractFields(entry);

  if (query.entity && fields.entity !== query.entity) return false;
  if (query.actor && fields.actor !== query.actor) return false;
  if (query.target && fields.target !== query.target) return false;
  if (query.instrument && fields.instrument !== query.instrument) return false;
  if (query.location && fields.location !== query.location) return false;

  return true;
}

function extractFields(entry: CaseEntry): Partial<CaseIndexRow> {
  switch (entry.case_type) {
    case 'nominative':
      return { entity: entry.entity, entry_timestamp: entry.timestamp };
    case 'genitive':
      return { owner: entry.owner, possessed: entry.possessed };
    case 'dative':
      return { giver: entry.giver, recipient: entry.recipient, object: entry.object };
    case 'accusative':
      return { subject: entry.subject, verb: entry.verb, object: entry.object };
    case 'instrumental':
      return { actor: entry.actor, instrument: entry.instrument, target: entry.target };
    case 'locative':
      return { entity: entry.entity, location: entry.location };
    case 'ablative':
      return { entity: entry.entity, origin: entry.origin, destination: entry.destination };
    case 'vocative':
      return { invoker: entry.invoker, invocation: entry.invocation, target: entry.target };
  }
}
