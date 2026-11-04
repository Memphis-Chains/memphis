/**
 * The block-type vocabulary, answered by the native core.
 *
 * WHY THIS EXISTS
 *
 * `crates/memphis-core/src/block.rs` defines `BlockType` as a CLOSED serde
 * enum. A block whose `data.type` is not one of its variants does not
 * deserialize at all — and the core is the thing that WRITES. The
 * TypeScript side used to have its own, looser notion of a legal block
 * (the sweep accepted anything that parsed as JSON and carried `index`
 * and `hash`), which is how a chain came to hold a block the core cannot
 * read while every gate stayed green.
 *
 * A second list would be the same drift with a different name. The core
 * cannot enumerate its own variants, but it can answer the only question
 * that matters: **is this type legal?** So this module asks the core, one
 * type at a time, and caches the answer.
 *
 * One vocabulary, one owner: the core. Nothing here lists block types.
 */

import { NapiChainAdapter } from './rust-chain-adapter.js';

export interface BlockTypeVerdict {
  /** The type that was probed. */
  readonly type: string;
  /** True when the native core can deserialize a block of this type. */
  readonly known: boolean;
  /** The core's complaint, when it refused. */
  readonly error?: string;
}

/** The block type used for anything the core does not know. */
export const CANONICAL_BLOCK_TYPE = 'system_event';

/**
 * The field that carries the original semantic name once a block has been
 * rewritten into the canonical shape. The repository's convention: "New
 * writes use `system_event` with the original semantic name in the `kind`
 * field of the data payload" (crates/memphis-core/src/block.rs:19).
 */
export const CANONICAL_KIND_FIELD = 'kind';

/**
 * The vocabulary, as an interface.
 *
 * The implementation asks the native core. Tests need to ask a
 * different question without a native bridge, so the shape is an
 * interface and the core-backed class is one implementation of it.
 */
export interface BlockVocabulary {
  /** False when the core could not be reached at all. */
  available(): boolean;
  /** Is this type legal? */
  isKnown(type: string): boolean;
  /** What the core says about this type. */
  verdict(type: string): BlockTypeVerdict;
  /** What the core says about this whole block; null when it accepts it. */
  complaint(block: ChainBlockLike): string | null;
}

/**
 * Probes the native core for the legality of block types.
 *
 * The probe is a full block, because that is what the core parses: the
 * envelope it returns says "invalid_block_json: unknown variant X" for a
 * type it does not know, and a hash complaint for one it does. The hash
 * complaint is expected — the probe's hash is deliberately not a real chain
 * hash — so only a PARSE failure counts as "unknown type".
 */
export class BlockVocabularyOracle implements BlockVocabulary {
  private readonly adapter: NapiChainAdapter;
  private readonly cache = new Map<string, BlockTypeVerdict>();

  constructor(rawEnv: NodeJS.ProcessEnv = process.env) {
    this.adapter = new NapiChainAdapter(rawEnv);
  }

  /** False when the native core could not be reached at all. */
  available(): boolean {
    try {
      this.adapter.validateBlock(probeBlock(CANONICAL_BLOCK_TYPE));
      return true;
    } catch {
      return false;
    }
  }

  /** Ask the core whether a block type is legal. Cached per type. */
  verdict(type: string): BlockTypeVerdict {
    const cached = this.cache.get(type);
    if (cached) return cached;

    let result: BlockTypeVerdict;
    try {
      this.adapter.validateBlock(probeBlock(type));
      result = { type, known: true };
    } catch (error) {
      const message = String((error as Error).message).replace(/^chain_validate:\s*/, '');
      // A parse failure means the type itself is not in the vocabulary.
      // Anything else (a bridge problem) is NOT a verdict about the type.
      if (/invalid_block_json/.test(message)) {
        result = { type, known: false, error: message };
      } else {
        result = { type, known: true, error: message };
      }
    }

    this.cache.set(type, result);
    return result;
  }

  isKnown(type: string): boolean {
    return this.verdict(type).known;
  }

  /**
   * Ask the core to parse a WHOLE block and report what it complained
   * about, or `null` when the core accepted it.
   *
   * This is the call the writer's own path uses, so the complaint is the
   * same text an operator would see from `chain_validate`. It also
   * checks the hash, so a complaint here is not only about the
   * vocabulary — callers that only care about the type must screen for
   * it first.
   */
  complaint(block: ChainBlockLike): string | null {
    try {
      this.adapter.validateBlock(block as never);
      return null;
    } catch (error) {
      return String((error as Error).message).replace(/^chain_validate:\s*/, '');
    }
  }
}

/**
 * The shape the core parses. Deliberately structural: the oracle must
 * not depend on the module that repairs blocks, or the two would pull
 * each other in.
 */
export interface ChainBlockLike {
  readonly index: number;
  readonly timestamp: string;
  readonly chain: string;
  readonly data: Record<string, unknown>;
  readonly prev_hash: string;
  readonly hash: string;
}

function probeBlock(type: string): {
  index: number;
  timestamp: string;
  chain: string;
  data: { type: string; content: string; tags: string[] };
  prev_hash: string;
  hash: string;
} {
  return {
    index: 0,
    timestamp: new Date().toISOString(),
    chain: 'system',
    data: { type, content: 'vocabulary-probe', tags: [] },
    prev_hash: '0'.repeat(64),
    hash: '0'.repeat(64),
  };
}
