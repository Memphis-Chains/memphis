/**
 * The rule that says whether the rotation's ARCHIVED history is intact.
 *
 * ## Why this module exists
 *
 * The rotation moves the oldest blocks of a chain into a gzipped archive
 * under `chains/.archives/`. Those blocks ARE the chain's history — the
 * rotation only moved them aside — and they travel inside every backup.
 *
 * Until now nothing checked them:
 *
 *   - the restore path had its own checks, buried inside
 *     `restoreChainFromArchive`;
 *   - the backup drill skipped the container and said so in its result
 *     (`foreignDirectories: [".archives"]`).
 *
 * So a backup could carry a corrupt archived history and still drill clean.
 * The error ledger named that as the ONE residual of the backup round:
 * "the rotation's `.jsonl.gz` archives inside a backup are still not
 * verified, because the drill has no reader for them".
 *
 * ## One owner, two callers
 *
 * The restore and the drill ask the same question — "are these archived
 * blocks intact?" — so the answer is computed HERE, once.
 * `restoreChainFromArchive` calls it before it writes anything; the backup
 * drill calls it on the archive it extracted. A rule with two owners is a
 * rule with two answers, and this repository has paid for that before.
 *
 * ## The checks, and what each one is for
 *
 * 1. **the hash** — the block's content still hashes to the value stored
 *    beside it, so the block was not altered;
 * 2. **the identity** — the block says which chain it belongs to, and the
 *    archive's name says the same thing. A block that carries a different
 *    chain is a DIFFERENT history of the same blocks, and the hash cannot
 *    see it (the identity sits inside the hash, so a wrong identity hashes
 *    consistently over the wrong value);
 * 3. **the index range** — the blocks are the contiguous range the archive's
 *    name promises, so nothing was dropped out of the middle;
 * 4. **the links** — each block points at the one before it, so the archive
 *    is one history and not a pile of blocks.
 *
 * ## The loop stays awake
 *
 * The verification is CPU — one SHA-256 per block — and the restore used to
 * run it in one burst. MEASURED on this host, 2026-11-25: the `system`
 * archive holds 15 271 blocks, and hashing them without a yield holds the
 * event loop for ~450 ms — the same kind of pause the drill's tar used to
 * cause. The blocks are verified in batches and the event loop is handed
 * back between them.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { expectedChainIdentity, hashBlock, type ChainBlock } from './chain-adapter.js';
import { parseArchiveFileName, readArchiveBlocks } from './chain-archive-format.js';

/**
 * How many blocks are verified between two yields to the event loop.
 *
 * The same trade-off as the chain verifier's (`chain-adapter.ts`): a bigger
 * batch is faster and yields less often. 64 blocks is a few milliseconds of
 * work at the measured cost per block.
 */
const VERIFY_BATCH_SIZE = 64;

/** What is wrong with an archive. */
export type ChainArchiveDefectCode =
  | 'empty-archive'
  | 'hash-mismatch'
  | 'identity-mismatch'
  | 'index-gap'
  | 'range-mismatch'
  | 'internal-chain-break'
  | 'unreadable';

/**
 * The error the rule raises when an archive is not intact.
 *
 * It carries the CODE, so a caller can map it onto its own vocabulary — the
 * restore has its own error type with its own codes, and it keeps them.
 */
export class ChainArchiveVerificationError extends Error {
  constructor(
    message: string,
    public readonly code: ChainArchiveDefectCode,
  ) {
    super(message);
    this.name = 'ChainArchiveVerificationError';
  }
}

/** What one archive turned out to hold. */
export interface ChainArchiveVerification {
  /** The archive's path. */
  archivePath: string;
  /** The chain the archive belongs to, as its name says. */
  chain: string;
  /** How many blocks were verified. */
  blocksChecked: number;
  /** The first block index the archive holds. */
  firstIndex: number | null;
  /** The last block index the archive holds. */
  lastIndex: number | null;
  /** The blocks themselves, in index order. */
  blocks: ChainBlock[];
}

/** What a whole container of archives turned out to hold. */
export interface RotationArchivesVerification {
  /** How many archives were verified. */
  archivesChecked: number;
  /** How many blocks were verified, over all of them. */
  blocksChecked: number;
  /** The archives, one entry each. */
  archives: ChainArchiveVerification[];
}

/**
 * Hand the event loop back for one turn.
 *
 * The same primitive the chain verifier uses (`chain-adapter.ts`): a pending
 * timer — the runtime's heartbeat, a stop watchdog — gets its turn before
 * the next batch starts.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The blocks an archive holds, read without holding the event loop.
 *
 * The reader is the format owner's (`chain-archive-format.ts`): the archive
 * is split into complete JSON VALUES, not into lines, so both the current
 * JSON Lines and the legacy pretty-printed archives are read by the same
 * code, and the decompression is streamed with a UTF-8 decoder that holds a
 * multi-byte character split across a chunk boundary.
 */
async function readBlocks(archivePath: string): Promise<ChainBlock[]> {
  return (await readArchiveBlocks(archivePath)) as unknown as ChainBlock[];
}

/**
 * Is that archive intact?
 *
 * @param expectedChain the chain the blocks must carry. The restore knows
 * it (it is restoring INTO that chain), and the container's reader knows it
 * (the rotation's archive is named after its chain). When it is not given,
 * the identity check is skipped — and that is stated, not hidden.
 *
 * @param checkNameRange when true, the archive's blocks must be the range
 * its NAME promises. The rotation names the archives it writes, so a
 * container of them carries that contract; a file handed to the restore by
 * hand does not have to.
 *
 * @throws ChainArchiveVerificationError when it is not intact, with the
 * reason.
 */
export async function verifyChainArchive(
  archivePath: string,
  options: {
    crypto?: typeof import('node:crypto');
    expectedChain?: string;
    checkNameRange?: boolean;
  } = {},
): Promise<ChainArchiveVerification> {
  const crypto = options.crypto ?? (await import('node:crypto'));
  const name = archivePath.split(/[\\/]/).pop() ?? archivePath;
  const parsedName = parseArchiveFileName(name);
  // The chain the blocks must carry: what the caller expects, or — for the
  // container's reader — what the archive's name says.
  //
  // The CANONICAL identity, not the raw name: a chain has an alias
  // (`pattern` -> `patterns`), and the blocks inside it carry the canonical
  // name — that is what the hash chain was built over. The owner's answer
  // (`expectedChainIdentity`) is the same one the chain verifier uses.
  const expected = options.expectedChain ?? parsedName?.chain;
  const chain = expected === undefined ? undefined : expectedChainIdentity(expected);

  let blocks: ChainBlock[];
  try {
    blocks = await readBlocks(archivePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ChainArchiveVerificationError(
      `rotation archive '${name}' could not be read: ${detail}`,
      'unreadable',
    );
  }

  if (blocks.length === 0) {
    throw new ChainArchiveVerificationError(
      `rotation archive '${name}' holds no blocks`,
      'empty-archive',
    );
  }

  // The blocks are checked in batches, and the event loop is handed back
  // between them: the verification is one SHA-256 per block, and 15 271 of
  // them in one burst is a ~450 ms pause.
  for (let start = 0; start < blocks.length; start += VERIFY_BATCH_SIZE) {
    const batch = blocks.slice(start, start + VERIFY_BATCH_SIZE);
    for (const block of batch) {
      const withoutHash = {
        index: block.index,
        timestamp: block.timestamp,
        chain: block.chain,
        data: block.data,
        prev_hash: block.prev_hash,
      };
      const expected = hashBlock(withoutHash as never, crypto);
      if (block.hash !== expected) {
        throw new ChainArchiveVerificationError(
          `rotation archive '${name}' is corrupt: block ${block.index} hashes to ${expected}, not ${block.hash}`,
          'hash-mismatch',
        );
      }
      if (chain !== undefined && block.chain !== chain) {
        throw new ChainArchiveVerificationError(
          `rotation archive '${name}' is corrupt: block ${block.index} carries the chain '${block.chain}', not '${chain}'`,
          'identity-mismatch',
        );
      }
    }
    await yieldToEventLoop();
  }

  // The links: each block points at the one before it. The blocks are read
  // in INDEX order, so the links are checked in the order the history runs.
  blocks.sort((a, b) => a.index - b.index);
  for (let i = 1; i < blocks.length; i += 1) {
    const previous = blocks[i - 1]!;
    const current = blocks[i]!;
    if (current.prev_hash !== previous.hash) {
      throw new ChainArchiveVerificationError(
        `rotation archive '${name}' is corrupt: block ${current.index} does not link to block ${previous.index}`,
        'internal-chain-break',
      );
    }
    if (current.index !== previous.index + 1) {
      throw new ChainArchiveVerificationError(
        `rotation archive '${name}' is corrupt: block index ${current.index} follows ${previous.index}`,
        'index-gap',
      );
    }
  }

  const first = blocks[0]!;
  const last = blocks[blocks.length - 1]!;
  if (
    options.checkNameRange === true &&
    parsedName !== null &&
    (first.index !== parsedName.firstIndex || last.index !== parsedName.lastIndex)
  ) {
    throw new ChainArchiveVerificationError(
      `rotation archive '${name}' holds blocks ${first.index}-${last.index}, but its name says ${parsedName.firstIndex}-${parsedName.lastIndex}`,
      'range-mismatch',
    );
  }

  return {
    archivePath,
    chain: chain ?? '',
    blocksChecked: blocks.length,
    firstIndex: first.index,
    lastIndex: last.index,
    blocks,
  };
}

/**
 * Are all the archives in this container intact?
 *
 * The container is the rotation's: `chains/.archives/`. Every archive in it
 * is verified, whatever chain it belongs to — the name says which.
 *
 * @throws ChainArchiveVerificationError on the first archive that is not
 * intact.
 */
export async function verifyRotationArchives(
  archivesDir: string,
  options: { crypto?: typeof import('node:crypto') } = {},
): Promise<RotationArchivesVerification> {
  let entries: string[];
  try {
    entries = readdirSync(archivesDir);
  } catch {
    // No container, no archives — nothing to verify, and nothing to say.
    return { archivesChecked: 0, blocksChecked: 0, archives: [] };
  }
  const archives: ChainArchiveVerification[] = [];
  let blocksChecked = 0;
  for (const entry of entries.filter((name) => name.endsWith('.jsonl.gz')).sort()) {
    // The container's archives are named by the rotation, so their names are
    // part of what they promise.
    const verification = await verifyChainArchive(join(archivesDir, entry), {
      ...options,
      checkNameRange: true,
    });
    archives.push(verification);
    blocksChecked += verification.blocksChecked;
  }
  return { archivesChecked: archives.length, blocksChecked, archives };
}
