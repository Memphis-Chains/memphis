import { join } from 'node:path';

import type {
  ChainAppendPayload,
  ChainQueryPayload,
  ChainValidatePayload,
  LoopStatePayload,
  SoulLoopStepPayload,
  SoulReplayPayload,
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
  loadPlatformAwareBridge,
  resolveBridgeContract,
  type BridgeAliasMap,
  type BridgeResolution,
} from './napi-contract.js';
import { getChainPath, getReadableChainPaths, normalizeChainName } from '../../config/paths.js';
import { normalizeBlockPayload } from '../../core/block-payload.js';
import { canonicalHash } from '../../core/chain-hash.js';
import { normalizeDecisionBlockData } from '../../core/decision-chain.js';
import type { Block } from '../../memory/chain.js';
import { resolveRustBridgePath } from '../runtime/install-root.js';

export { withNapiAppendLock };

const CHAIN_BRIDGE_ALIASES = {
  chain_append: ['chain_append', 'chainAppend'],
  chain_validate: ['chain_validate', 'chainValidate'],
  chain_query: ['chain_query', 'chainQuery'],
  soul_replay: ['soul_replay', 'soulReplay'],
  soul_loop_step: ['soul_loop_step', 'soulLoopStep'],
} satisfies BridgeAliasMap<
  'chain_append' | 'chain_validate' | 'chain_query' | 'soul_replay' | 'soul_loop_step'
>;

type ChainBridgeKey = keyof typeof CHAIN_BRIDGE_ALIASES;

interface ResolvedChainBridge {
  chain_append?: (chainJson: string, blockJson: string) => string;
  chain_validate?: (blockJson: string, prevJson?: string) => string;
  chain_query?: (chainJson: string, contains?: string, tag?: string) => string;
  soul_replay?: (chainName: string, blocksJson: string) => string;
  soul_loop_step?: (stateJson: string, actionJson: string, limitsJson?: string) => string;
}

interface SoulReplayBlockData {
  block_type: string;
  content: string;
  tags: string[];
}

/**
 * The bridge's payloads — the OWNER's shapes.
 *
 * These used to be hand-written interfaces in this file, four of them,
 * and they were guesses: `SoulReplayResult` declared its own snapshot,
 * `SoulLoopState` its own six fields, and `ValidateBlockResult` its own
 * `errors?: string[]` without knowing that the key is ABSENT on the
 * success path (the Rust struct skips it) rather than null.
 *
 * Now they come from `bridge-payloads.generated.ts` — projected from
 * `crates/memphis-napi/src/bridge_payloads.rs` — so a field can only be
 * read under the name the built bridge really puts on it.
 */

/** What a block validation answers. */
export type ValidateBlockResult = ChainValidatePayload;

/** What a chain query answers. */
export type QueryBlocksResult = ChainQueryPayload;

/** What a replay made of the blocks. */
export type SoulReplayResult = SoulReplayPayload;

/** The soul loop's state after a step. */
export type SoulLoopState = LoopStatePayload;

/** What one loop step answers. */
export type SoulLoopStepResult = SoulLoopStepPayload;

export interface AppendBlockResult {
  index: number;
  hash: string;
  chain: string;
  timestamp: string;
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

function getBridgePath(rawEnv: NodeJS.ProcessEnv): string {
  return resolveRustBridgePath(rawEnv);
}

function resolveChainBridge(
  rawEnv: NodeJS.ProcessEnv = process.env,
): BridgeResolution<ChainBridgeKey> {
  return resolveBridgeContract(
    loadPlatformAwareBridge(getBridgePath(rawEnv)),
    CHAIN_BRIDGE_ALIASES,
  );
}

function toNapiBlock(
  chain: string,
  index: number,
  data: Record<string, unknown>,
  prevHash: string,
): NapiBlock {
  const normalizedChain = normalizeChainName(chain) ?? chain;
  const timestamp = new Date().toISOString();
  const normalized = normalizeBlockPayload(data) as NapiBlockData;

  // The canonical hash has ONE implementation: `core/chain-hash.ts`.
  //
  // This module used to build the payload and hash it inline, with its own
  // copy of the three-field projection. That is a second rule for one
  // thing, and the copy had no `block_type` fallback at all.
  const hashPayload = {
    index,
    timestamp,
    chain: normalizedChain,
    data: normalized,
    prev_hash: prevHash,
  };

  return {
    index,
    timestamp,
    chain: normalizedChain,
    data: normalized,
    prev_hash: prevHash,
    hash: canonicalHash(hashPayload),
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

async function readChainBlocks(
  chain: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
  tail?: number,
): Promise<NapiBlock[]> {
  const normalizedChain = normalizeChainName(chain) ?? chain;
  const blocks: NapiBlock[] = [];
  const seen = new Set<string>();

  for (const dir of getReadableChainPaths(normalizedChain, rawEnv)) {
    const allFiles = await listBlockFiles(dir);
    // Block files are zero-padded and `listBlockFiles` sorts them
    // lexicographically, so the tail of the listing is the newest
    // blocks of that directory.
    //
    // Reading only the tail is what keeps a caller that wants the last
    // twenty blocks from materialising fifteen thousand of them. The
    // `system` chain alone holds 15 730 blocks / 62 MB, and the `insights`
    // chain 402 blocks / 32 MB.
    const files =
      tail !== undefined && tail > 0 && allFiles.length > tail
        ? allFiles.slice(-tail)
        : allFiles;
    // Parse errors and unexpected read errors must propagate — a corrupted block must
    // never be silently treated as "chain is empty" because the caller would then
    // regenerate a fresh genesis and overwrite existing blocks (see issue #70).
    const loaded = await Promise.all(
      files.map((file) => readBlockFile<NapiBlock>(join(dir, file))),
    );

    for (const block of loaded) {
      const key = `${block.hash}:${block.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const normalizedData =
        normalizedChain === 'decisions' && block.data
          ? (normalizeDecisionBlockData(block.data as Record<string, unknown>) as NapiBlockData)
          : (normalizeBlockPayload((block.data ?? {}) as Record<string, unknown>) as NapiBlockData);

      blocks.push({
        ...block,
        chain: normalizedChain,
        data: normalizedData,
      });
    }
  }

  return blocks.sort((a, b) => a.index - b.index);
}

async function writeBlock(
  chain: string,
  block: NapiBlock,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const normalizedChain = normalizeChainName(chain) ?? chain;
  const dir = getChainPath(normalizedChain, rawEnv);
  const payload = serializeBlockForDisk({ ...block, chain: normalizedChain });
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
    const bounded = Math.max(1, limit);
    const blocks = await readChainBlocks(chain, this.rawEnv, bounded);
    return blocks.slice(-bounded);
  }

  async appendBlock(chain: string, data: Record<string, unknown>): Promise<AppendBlockResult> {
    const normalizedData = normalizeBlockPayload(data) as NapiBlockData;
    const result = await this.appendBlockWithDecision(chain, async () => ({ data: normalizedData, value: undefined }), false);
    if (!result.block) throw new Error('chain append unexpectedly skipped');
    return result.block;
  }

  /** Decide and optionally append under the same lock as all chain writers. */
  async appendBlockConditional<T>(chain: string,
    decide: () => Promise<{ data?: Record<string, unknown>; value: T }>,
  ): Promise<{ value: T; block?: AppendBlockResult }> {
    return this.appendBlockWithDecision(chain, decide, true);
  }

  private async appendBlockWithDecision<T>(chain: string,
    decide: () => Promise<{ data?: Record<string, unknown>; value: T }>,
    preflight: boolean,
  ): Promise<{ value: T; block?: AppendBlockResult }> {
    // Freeze the runtime paths before the first await: test teardown or
    // config reload must not redirect this append after its guard and lock.
    const writeEnv = { ...this.rawEnv };
    const normalizedChain = normalizeChainName(chain) ?? chain;
    const chainsDir = getChainPath(normalizedChain, writeEnv);
    assertChainWriteAllowed(chainsDir, writeEnv);
    return withNapiAppendLock(chainsDir, async () => {
      const bridge = this.getBridgeOrThrow().resolved as ResolvedChainBridge;
      const appendFn = bridge.chain_append;
      if (typeof appendFn !== 'function') {
        throw new Error('chain_append not available in rust bridge');
      }

      const chainBlocks = await readChainBlocks(normalizedChain, writeEnv);
      const nextIndex = (chainBlocks.at(-1)?.index ?? 0) + 1;
      const prevHash = chainBlocks.at(-1)?.hash ?? '0'.repeat(64);
      if (preflight) {
        const validateFn = bridge.chain_validate;
        if (typeof validateFn !== 'function') throw new Error('chain_validate not available for conditional append');
        for (let index = 0; index < chainBlocks.length; index += 1) {
          const current = chainBlocks[index]!;
          const previous = index > 0 ? JSON.stringify(chainBlocks[index - 1]) : undefined;
          const validation = parseEnvelope<ValidateBlockResult>(
            validateFn(JSON.stringify(current), previous), 'chain_validate preflight');
          if (!validation.valid) throw new Error(`chain preflight rejected block ${current.index}: ${(validation.errors ?? []).join(', ') || 'invalid'}`);
        }
        const probe = toNapiBlock(normalizedChain, nextIndex,
          { type: 'system_event', kind: 'conditional.preflight', content: 'preflight', tags: [] }, prevHash);
        const checked = parseEnvelope<{ appended: boolean; errors?: string[] }>(
          appendFn(JSON.stringify(chainBlocks), JSON.stringify(probe)), 'chain_append preflight');
        if (!checked.appended) throw new Error(`chain preflight rejected: ${(checked.errors ?? []).join(', ') || 'unknown error'}`);
      }
      const decision = await decide();
      if (!decision.data) return { value: decision.value };
      const data = decision.data;
      const nextBlock = toNapiBlock(normalizedChain, nextIndex, data, prevHash);

      type AppendData = ChainAppendPayload;
      const out = parseEnvelope<AppendData>(
        appendFn(JSON.stringify(chainBlocks), JSON.stringify(nextBlock)),
        'chain_append',
      );

      if (!out.appended) {
        throw new Error(
          `chain_append rejected block: ${(out.errors ?? []).join(', ') || 'unknown error'}`,
        );
      }

      const appended = out.chain?.at(-1);
      if (!appended) {
        throw new Error('chain_append returned empty chain');
      }

      // The bridge's block carries EXACTLY the three data fields the
      // chain contract gives a meaning to — the Rust struct drops
      // anything else — so the file keeps the extras the TypeScript side
      // wrote and takes the three words from the bridge.
      const persisted: NapiBlock = {
        index: appended.index,
        timestamp: appended.timestamp,
        chain: normalizedChain,
        prev_hash: appended.prev_hash,
        hash: appended.hash,
        ...(appended.signer !== undefined ? { signer: appended.signer } : {}),
        ...(appended.signature !== undefined ? { signature: appended.signature } : {}),
        data: {
          ...nextBlock.data,
          type: appended.data.type,
          content: appended.data.content,
          tags: appended.data.tags,
        },
      };

      await writeBlock(normalizedChain, persisted, writeEnv);

      return { value: decision.value, block: {
        index: appended.index,
        hash: appended.hash,
        chain: normalizedChain,
        timestamp: appended.timestamp,
      } };
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
  const bounded = Math.max(1, limit);
  // The limit is pushed down into the reader. Slicing after the fact
  // would still have read every block of the chain — which is what turned
  // a "give me the last 20 blocks" call into a 62 MB read.
  const blocks = await readChainBlocks(chain, rawEnv, bounded);
  return blocks.slice(-bounded);
}
