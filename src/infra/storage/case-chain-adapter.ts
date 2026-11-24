import { join } from 'node:path';

import { BRIDGE_EXPORT_ALIASES } from './bridge-exports.generated.js';
import type {
  BlockPayload,
  CaseAppendPayload,
  CaseIndexRowPayload,
  CaseIndexStatusPayload,
  CaseQueryPayload,
  CaseRebuildPayload,
} from './bridge-payloads.generated.js';
import {
  listBlockFiles,
  parseEnvelope,
  readBlockFile,
  serializeBlockForDisk,
  withNapiAppendLock,
  writeBlockAtomic,
  type NapiBlock,
  type NapiBlockData,
} from './chain-file-io.js';
import { assertChainWriteAllowed } from './chain-write-guard.js';
import {
  hasRequiredBridgeExports,
  loadPlatformAwareBridge,
  resolveBridgeContract,
  type BridgeAliasMap,
  type BridgeResolution,
} from './napi-contract.js';
import { getChainPath, getDataDir } from '../../config/paths.js';
import { canonicalHash } from '../../core/chain-hash.js';
import { parseBool } from '../../core/env.js';
import type {
  CaseAppendResult,
  CaseEntry,
  CaseQuery,
} from '../../memory/case-types.js';
import { resolveRustBridgePath } from '../runtime/install-root.js';

/**
 * The case bridge's spellings come from the GENERATED vocabulary.
 *
 * They used to be written out here — a hand-written copy of three entries
 * of the bridge's export map, which is itself generated from the Rust
 * core. Two copies of one rule, and the copy here was the one that could
 * not name an export the bridge actually has.
 */
const CASE_BRIDGE_ALIASES = {
  case_append: BRIDGE_EXPORT_ALIASES.case_append,
  case_query: BRIDGE_EXPORT_ALIASES.case_query,
  case_rebuild: BRIDGE_EXPORT_ALIASES.case_rebuild,
  case_index_status: BRIDGE_EXPORT_ALIASES.case_index_status,
} satisfies BridgeAliasMap<
  'case_append' | 'case_query' | 'case_rebuild' | 'case_index_status'
>;

type CaseBridgeKey = keyof typeof CASE_BRIDGE_ALIASES;

interface ResolvedCaseBridge {
  case_append?: (chainJson: string, entryJson: string, indexDbPath: string) => string;
  case_query?: (queryJson: string, indexDbPath: string) => string;
  case_rebuild?: (blocksJson: string, indexDbPath: string) => string;
  case_index_status?: (indexDbPath: string) => string;
}

/**
 * Where the bridge lives — the CENTRAL resolver, not a local copy.
 *
 * This used to be `rawEnv.RUST_CHAIN_BRIDGE_PATH ?? './crates/memphis-napi'`:
 * a relative path, resolved against `process.cwd()`. The footgun was
 * already documented and centralised away in `install-root.ts` after the
 * 2026-04-26 incident ("Rust vault bridge not found at ./crates/memphis-napi"
 * for an operator running `memphis` from $HOME) — and this file survived it.
 *
 * The consequence of the bypass: in a shell whose working directory is not
 * the checkout, the case bridge silently failed to load and the adapter fell
 * back to the TypeScript implementation of the same rule. A silent switch
 * between two implementations, decided by the working directory.
 */
function getBridgePath(rawEnv: NodeJS.ProcessEnv): string {
  return resolveRustBridgePath(rawEnv);
}

function resolveCaseBridge(
  rawEnv: NodeJS.ProcessEnv = process.env,
): BridgeResolution<CaseBridgeKey> {
  return resolveBridgeContract(loadPlatformAwareBridge(getBridgePath(rawEnv)), CASE_BRIDGE_ALIASES);
}

function getIndexDbPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return join(getDataDir(rawEnv), 'case-index.sqlite');
}

/**
 * What the case adapter sees of the bridge.
 *
 * The vault adapter has the same shape (`getRustVaultAdapterStatus`), and it
 * exists for the same reason: the doctor has to be able to say WHERE the
 * bridge was looked for and whether it was found, because a bridge that is
 * not found does not fail — it silently hands the work to the TypeScript
 * implementation of the same rule.
 */
export interface CaseChainAdapterStatus {
  rustEnabled: boolean;
  rustBridgePath: string;
  bridgeLoaded: boolean;
  caseApiAvailable: boolean;
}

export function getCaseChainAdapterStatus(
  rawEnv: NodeJS.ProcessEnv = process.env,
): CaseChainAdapterStatus {
  const resolution = resolveCaseBridge(rawEnv);
  return {
    rustEnabled: parseBool(rawEnv.RUST_CHAIN_ENABLED, false),
    rustBridgePath: getBridgePath(rawEnv),
    bridgeLoaded: resolution.bridgeLoaded,
    caseApiAvailable: hasRequiredBridgeExports(resolution, [
      'case_append',
      'case_query',
      'case_rebuild',
    ]),
  };
}

const CHAIN_NAME = 'cases';

/**
 * The wire's block, as the file wants it.
 *
 * The bridge's `Block` carries EXACTLY the three data fields the chain
 * contract gives a meaning to — the Rust struct drops anything else the
 * file had — so this is a projection, not a translation. It is also what
 * the adapter has always written: the block it wrote came from the
 * bridge, and the bridge's block never had more than those three.
 */
function toFileBlock(block: BlockPayload): NapiBlock {
  return {
    index: block.index,
    timestamp: block.timestamp,
    chain: block.chain,
    data: {
      type: block.data.type,
      content: block.data.content,
      tags: block.data.tags,
    },
    prev_hash: block.prev_hash,
    hash: block.hash,
    ...(block.signer !== undefined ? { signer: block.signer } : {}),
    ...(block.signature !== undefined ? { signature: block.signature } : {}),
  };
}

async function readChainBlocks(
  chain: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<NapiBlock[]> {
  const dir = getChainPath(chain, rawEnv);
  const files = await listBlockFiles(dir);
  return Promise.all(files.map((file) => readBlockFile<NapiBlock>(join(dir, file))));
}

async function writeBlock(
  chain: string,
  block: NapiBlock,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dir = getChainPath(chain, rawEnv);
  const payload = serializeBlockForDisk(block);
  await writeBlockAtomic(dir, block.index, payload);
}

function toNapiBlock(
  chain: string,
  index: number,
  data: NapiBlockData,
  prevHash: string,
): NapiBlock {
  const timestamp = new Date().toISOString();

  // The canonical hash has ONE implementation: `core/chain-hash.ts`.
  //
  // This module used to build the hash payload inline, over the FULL
  // `data`, and hash that. The canonical hash covers a three-field
  // projection of `data` (type/content/tags), so the two formulas agreed
  // only while the payload carried exactly those three fields — and the
  // moment a case entry grew a fourth field, this writer would have
  // produced a hash the native core could not reproduce.
  //
  // Measured 2026-11-23 on this host: 0 of 2 190 blocks on the `cases`
  // chain use this formula, so the divergence never bit. The corpus
  // cannot prove a rule, so the rule was taken from the owner.
  return {
    index,
    timestamp,
    chain,
    data,
    prev_hash: prevHash,
    hash: canonicalHash({ index, timestamp, chain, data, prev_hash: prevHash }),
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
    if (!parseBool(this.rawEnv.RUST_CHAIN_ENABLED, false)) return false;
    return hasRequiredBridgeExports(this.bridge, ['case_append', 'case_query', 'case_rebuild']);
  }

  async appendCaseEntry(entry: CaseEntry): Promise<CaseAppendResult> {
    // A single append must keep its data directory and index together even
    // when the caller changes its environment while asynchronous I/O runs.
    const writeEnv = { ...this.rawEnv };
    assertChainWriteAllowed(getChainPath(CHAIN_NAME, writeEnv), writeEnv);
    if (this.rustAvailable) {
      return this.appendViaRust(entry, writeEnv);
    }
    return this.appendViaTs(entry, writeEnv);
  }

  async queryCases(query: CaseQuery): Promise<CaseQueryPayload> {
    if (this.rustAvailable) {
      // THE INDEX IS A CACHE, AND THE CHAIN IS THE TRUTH. So the cache is
      // checked BEFORE it is read — because a cache that is behind answers
      // with a SUBSET, and the subset looks like an answer.
      //
      // MEASURED 2026-11-24 on the operator's host: the index held 1 372
      // entries where the `cases` chain holds 2 190 case blocks, and the
      // missing 818 included the host's ONLY nominative entry and BOTH
      // instrumental ones. Nothing noticed: the index's HIGHEST block
      // index was the chain's last, so every cheap signal said "fine".
      await this.reconcileIfNeeded();
      return this.queryViaRust(query);
    }
    return this.queryViaTs(query);
  }

  async rebuildIndex(): Promise<CaseRebuildPayload> {
    if (this.rustAvailable) {
      return this.rebuildViaRust();
    }
    // The owner's shape has THREE keys — `indexed`, `skipped` and
    // `errors`. The TypeScript path does not rebuild anything, so it
    // reports zero of each; it used to report two of the three, because
    // nobody had heard of `skipped`.
    return { indexed: 0, skipped: 0, errors: 0 };
  }

  /**
   * The index's health — how many entries it holds.
   *
   * `null` when the bridge cannot answer: a binary from before
   * 2026-11-24 has no `case_index_status`, and a runtime that cannot ask
   * must still work — it keeps using the index as it finds it. That is
   * the compatibility window, and it is why the export is OPTIONAL.
   */
  private indexStatus(): { indexed: number; lastIndexedBlock: number | null } | null {
    const bridge = this.bridge.resolved as ResolvedCaseBridge;
    const statusFn = bridge.case_index_status;
    if (typeof statusFn !== 'function') return null;

    const raw = statusFn(getIndexDbPath(this.rawEnv));
    const out = parseEnvelope<CaseIndexStatusPayload>(raw, 'case_index_status');
    return { indexed: out.indexed, lastIndexedBlock: out.lastIndexedBlock };
  }

  /**
   * Bring the index in step with the chain, when it is not.
   *
   * THIS FUNCTION EXISTED AND WAS NEVER CALLED. MEASURED 2026-11-24: it
   * had no caller in the tree, and `rebuildIndex()` beside it had none
   * either — so the mechanism that was written to repair exactly this
   * state (its own doc says "Ensures the index matches the filesystem
   * after a potential partial write") sat idle while the index lost 818
   * entries.
   *
   * The check is a COUNT, and it has to be: the index's highest block
   * index was the chain's last, so the highest index cannot see a gap at
   * the HEAD — and the gap was at the head.
   *
   * The count is the chain's own count of CASE blocks, not its count of
   * blocks. A chain that held a block of another type would make the
   * cheap comparison (the number of files) wrong, and a wrong comparison
   * would rebuild on every query for ever. The exact count costs a scan
   * of the chain — MEASURED on the operator's host: 70 ms for 2 190
   * blocks, against 20 ms for the query it protects.
   *
   * And it cannot loop: the rebuild makes the index hold exactly the
   * chain's case blocks, so the next comparison is equal.
   */
  async reconcileIfNeeded(): Promise<CaseRebuildPayload | null> {
    if (!this.rustAvailable) return null;

    const chainBlocks = await readChainBlocks(CHAIN_NAME, this.rawEnv);
    const caseBlockCount = chainBlocks.filter((block) => block.data.type === 'case').length;
    if (caseBlockCount === 0) return null;

    const status = this.indexStatus();
    if (status === null) return null;
    if (status.indexed === caseBlockCount) return null;

    return this.rebuildViaRust(chainBlocks);
  }

  private async appendViaRust(
    entry: CaseEntry,
    writeEnv: NodeJS.ProcessEnv,
  ): Promise<CaseAppendResult> {
    // Serialize the full read-compute-write cycle under the same lock used by
    // NapiChainAdapter.appendBlock, so concurrent case_append calls cannot race
    // and produce duplicate or out-of-order blocks (see issue #70).
    const chainsDir = getChainPath(CHAIN_NAME, writeEnv);
    return withNapiAppendLock(chainsDir, async () => {
      const bridge = this.bridge.resolved as ResolvedCaseBridge;
      const appendFn = bridge.case_append!;

      const chainBlocks = await readChainBlocks(CHAIN_NAME, writeEnv);
      const chainJson = JSON.stringify(chainBlocks);
      const entryJson = JSON.stringify(entry);
      const indexDbPath = getIndexDbPath(writeEnv);

      const raw = appendFn(chainJson, entryJson, indexDbPath);

      const out = parseEnvelope<CaseAppendPayload>(raw, 'case_append');

      if (!out.appended) {
        throw new Error(
          `case_append rejected entry: ${(out.errors ?? []).join(', ') || 'unknown error'}`,
        );
      }

      const block = out.chain?.at(-1);
      if (!block) {
        throw new Error('case_append returned no block');
      }

      try {
        await writeBlock(CHAIN_NAME, toFileBlock(block), writeEnv);
      } catch (writeErr) {
        // writeBlock failed after Rust already updated the SQLite index — rebuild to re-sync
        try {
          await this.rebuildViaRust(undefined, writeEnv);
        } catch {
          // best-effort rebuild
        }
        throw new Error(
          `case_append writeBlock failed (index rebuilt): ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        );
      }

      return {
        success: true,
        index: block.index,
        hash: block.hash,
        chain: CHAIN_NAME,
        timestamp: block.timestamp,
        case_type: entry.case_type,
      };
    });
  }

  private async appendViaTs(
    entry: CaseEntry,
    writeEnv: NodeJS.ProcessEnv,
  ): Promise<CaseAppendResult> {
    return withNapiAppendLock(getChainPath(CHAIN_NAME, writeEnv), () =>
      this.appendViaTsLocked(entry, writeEnv),
    );
  }

  private async appendViaTsLocked(
    entry: CaseEntry,
    writeEnv: NodeJS.ProcessEnv,
  ): Promise<CaseAppendResult> {
    const chainBlocks = await readChainBlocks(CHAIN_NAME, writeEnv);
    const nextIndex = (chainBlocks.at(-1)?.index ?? 0) + 1;
    const prevHash = chainBlocks.at(-1)?.hash ?? '0'.repeat(64);

    const caseTag = `case:${entry.case_type}`;
    const data: NapiBlockData = {
      type: 'case',
      content: JSON.stringify(entry),
      tags: [caseTag],
    };

    const block = toNapiBlock(CHAIN_NAME, nextIndex, data, prevHash);
    await writeBlock(CHAIN_NAME, block, writeEnv);

    return {
      success: true,
      index: block.index,
      hash: block.hash,
      chain: CHAIN_NAME,
      timestamp: block.timestamp,
      case_type: entry.case_type,
    };
  }

  private async queryViaRust(query: CaseQuery): Promise<CaseQueryPayload> {
    const bridge = this.bridge.resolved as ResolvedCaseBridge;
    const queryFn = bridge.case_query!;
    const indexDbPath = getIndexDbPath(this.rawEnv);

    const raw = queryFn(JSON.stringify(query), indexDbPath);
    return parseEnvelope<CaseQueryPayload>(raw, 'case_query');
  }

  /**
   * The TypeScript path — and it answers with the SAME shape as the Rust
   * path, which is the whole point.
   *
   * It used to answer with the hand-written `CaseIndexRow`: TWENTY-FOUR
   * flat fields, none of which the wire sends, and MISSING the `entry`
   * that carries the case. So the two paths of the same adapter
   * answered differently, and the explain command read fields that only
   * one of them had.
   */
  private async queryViaTs(query: CaseQuery): Promise<CaseQueryPayload> {
    const chainBlocks = await readChainBlocks(CHAIN_NAME, this.rawEnv);
    const entries: CaseIndexRowPayload[] = [];

    // Scan blocks in reverse (most recent first) — the SQLite query
    // orders by `block_index DESC`, so the two paths agree.
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
          entry: parsed,
        });

        if (query.limit && entries.length >= query.limit) break;
      } catch (err) {
        console.warn('[case-chain-adapter] skipping malformed chain entry', String(err));
      }
    }

    return { count: entries.length, entries };
  }

  private async rebuildViaRust(
    chainBlocks?: NapiBlock[],
    rawEnv: NodeJS.ProcessEnv = this.rawEnv,
  ): Promise<CaseRebuildPayload> {
    const bridge = this.bridge.resolved as ResolvedCaseBridge;
    const rebuildFn = bridge.case_rebuild!;

    // The chain may already be in hand — the reconciliation reads it to
    // COUNT the case blocks, and reading it twice would double the cost
    // of the check that protects every query.
    const blocks = chainBlocks ?? (await readChainBlocks(CHAIN_NAME, rawEnv));
    const indexDbPath = getIndexDbPath(rawEnv);

    const raw = rebuildFn(JSON.stringify(blocks), indexDbPath);
    return parseEnvelope<CaseRebuildPayload>(raw, 'case_rebuild');
  }
}

/**
 * The filter the case index applies — and the one the TypeScript path
 * has to apply too, or the two paths answer different questions.
 *
 * The SQLite index filters on the DENORMALIZED columns, and it fills
 * those from the entry's accessors (`CaseEntry::entity()`,
 * `::actor()`, `::target()`, `::instrument()`, `::location()`). So the
 * accessors below are the same five, with the same cases.
 */
function matchesQuery(entry: CaseEntry, query: CaseQuery): boolean {
  if (query.case_type && entry.case_type !== query.case_type) return false;

  if (query.entity && entryField(entry, 'entity') !== query.entity) return false;
  if (query.actor && entryField(entry, 'actor') !== query.actor) return false;
  if (query.target && entryField(entry, 'target') !== query.target) return false;
  if (query.instrument && entryField(entry, 'instrument') !== query.instrument) return false;
  if (query.location && entryField(entry, 'location') !== query.location) return false;

  return true;
}

/**
 * One of the five common fields of a case entry — the same ones the Rust
 * core exposes as accessors.
 */
function entryField(
  entry: CaseEntry,
  field: 'entity' | 'actor' | 'target' | 'instrument' | 'location',
): string | undefined {
  switch (entry.case_type) {
    case 'nominative':
      return field === 'entity' ? entry.entity : undefined;
    case 'genitive':
    case 'dative':
    case 'accusative':
      return undefined;
    case 'instrumental':
      if (field === 'actor') return entry.actor;
      if (field === 'target') return entry.target;
      if (field === 'instrument') return entry.instrument;
      return undefined;
    case 'locative':
      if (field === 'entity') return entry.entity;
      if (field === 'location') return entry.location;
      return undefined;
    case 'ablative':
      return field === 'entity' ? entry.entity : undefined;
    case 'vocative':
      return field === 'target' ? entry.target : undefined;
    default: {
      // Exhaustive check — this cannot be reached while CaseEntry is
      // maintained, and the Rust side throws on an unknown case too.
      throw new Error(`Unknown case_type: ${(entry as { case_type?: string }).case_type}`);
    }
  }
}
