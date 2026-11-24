/**
 * The marker that says "this chain continues from an archived prefix".
 *
 * ## Why this exists
 *
 * Chain rotation archives the old blocks of a chain and keeps the tail
 * live. That is the mechanism that stops the `system` chain from growing
 * without bound — 15 748 blocks / 62 MB on the operator's host, growing by
 * 100-280 blocks a day.
 *
 * But the rotated chain did not verify.
 *
 * Measured 2026-11-22: rotating a COPY of the live `system` chain with
 * the repo's own `rotateChain` produced this on the very next command:
 *
 *     [INTERNAL_ERROR] chain 'system' integrity check failed at block
 *     15739 (015739.json): missing genesis block (chain must start at
 *     index 0 or 1)
 *
 * The validators require the first live block to be the genesis block,
 * because that is what makes the chain's history provable: every block
 * links to its predecessor back to the beginning. Rotation breaks that
 * link — the first live block links to a block that is no longer in the
 * directory.
 *
 * That is why rotation was never enabled. `docs/design/MEMPHIS-CRASH-REBUILD.md`
 * §6 lists "the `system` chain still grows without bound" and notes that
 * "chain rotation exists and is not enabled". The reason was not
 * oversight: the feature produced a chain the runtime itself rejected.
 *
 * ## The rule
 *
 * The archive is not lost — it is written to a `.jsonl.gz` file and the
 * snapshot is taken before it. So the live chain does not need to start
 * at genesis. It needs to start at a point whose link to the archive can
 * be PROVEN.
 *
 * The marker carries that proof: the index and the hash of the last
 * archived block. The first live block must be exactly one index after
 * it, and its `prev_hash` must be exactly that hash. A marker that does
 * not match is rejected, so a truncated or spliced chain still fails.
 *
 * ## One format, two arms
 *
 * The TypeScript validator (`src/infra/storage/chain-adapter.ts`) and the
 * Rust one (`crates/memphis-operator/src/chat_memory.rs`) must agree, so
 * the shape is a contract fixture both arms read:
 * `tests/fixtures/chain-rotation-head-contract.json`.
 *
 * The file name deliberately does NOT end in `.json`: a chain directory
 * is read as a list of `.json` blocks by at least six places in this
 * repository, and a marker named `*.json` would be parsed as a block.
 */

export const ROTATION_HEAD_FORMAT = 'memphis-chain-rotation-head.v1';

/**
 * The marker's file name inside a chain directory.
 *
 * Not `.json` on purpose — see the module header.
 */
export const ROTATION_HEAD_FILENAME = 'chain-rotation.head';

export interface ChainRotationHead {
  format: typeof ROTATION_HEAD_FORMAT;
  chain: string;
  /** The first index that was archived. */
  archivedFrom: number;
  /** The last index that was archived. */
  archivedTo: number;
  /** The index of the last archived block — the predecessor of the first live block. */
  lastArchivedIndex: number;
  /** The hash of the last archived block — the `prev_hash` of the first live block. */
  lastArchivedHash: string;
  /** Where the archive was written. */
  archivePath: string;
  rotatedAt: string;
}

/** Is this object a well-formed rotation head? */
export function isChainRotationHead(value: unknown): value is ChainRotationHead {
  if (!value || typeof value !== 'object') return false;
  const head = value as Record<string, unknown>;
  return (
    head.format === ROTATION_HEAD_FORMAT &&
    typeof head.chain === 'string' &&
    head.chain.length > 0 &&
    Number.isSafeInteger(head.archivedFrom) &&
    Number.isSafeInteger(head.archivedTo) &&
    Number.isSafeInteger(head.lastArchivedIndex) &&
    typeof head.lastArchivedHash === 'string' &&
    /^[a-f0-9]{64}$/.test(head.lastArchivedHash) &&
    typeof head.archivePath === 'string' &&
    typeof head.rotatedAt === 'string'
  );
}

/**
 * Does the first live block continue the archived prefix?
 *
 * The whole point of the marker: the chain's history is provable even
 * though the prefix lives in an archive.
 */
export function continuesArchivedPrefix(
  head: ChainRotationHead | null,
  firstLiveIndex: number,
  firstLivePrevHash: string,
): boolean {
  if (!head) return false;
  if (head.lastArchivedIndex + 1 !== firstLiveIndex) return false;
  return head.lastArchivedHash === firstLivePrevHash;
}

/** The `prev_hash` a genesis block carries. */
export const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * May a chain start here?
 *
 * Two ways to be right, and no third:
 *
 * 1. The chain starts at genesis — index 0 with the genesis hash, or
 *    index 1 with an empty or genesis `prev_hash`. This is what a chain
 *    that was never rotated looks like.
 * 2. The chain CONTINUES an archived prefix, and the marker proves it:
 *    the first live block is exactly one index after the archived head
 *    and links to it.
 *
 * Everything else is a broken chain. A marker that does not match is not
 * a licence: a truncated or spliced chain still fails.
 */
export function isValidChainStart(
  head: ChainRotationHead | null,
  firstLiveIndex: number,
  firstLivePrevHash: string,
): boolean {
  if (continuesArchivedPrefix(head, firstLiveIndex, firstLivePrevHash)) return true;
  if (firstLiveIndex === 0) return firstLivePrevHash === GENESIS_PREV_HASH;
  if (firstLiveIndex === 1) {
    return firstLivePrevHash === '' || firstLivePrevHash === GENESIS_PREV_HASH;
  }
  return false;
}

/**
 * Parse the marker out of raw file content.
 *
 * The file holds ONE JSON object. A parse failure means "no usable
 * marker", which makes the validator fall back to the genesis rule —
 * fail closed, never fail open.
 */
export function parseChainRotationHead(raw: string): ChainRotationHead | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isChainRotationHead(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Read the marker from a chain directory.
 *
 * A missing marker is not an error: a chain that has never been rotated
 * has none, and the validators apply the genesis rule to it.
 */
export async function readChainRotationHead(chainDir: string): Promise<ChainRotationHead | null> {
  const { readFile } = await import('node:fs/promises');
  try {
    return parseChainRotationHead(await readFile(`${chainDir}/${ROTATION_HEAD_FILENAME}`, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write the marker into a chain directory.
 *
 * Written atomically: a half-written marker would parse as "no marker",
 * which fails closed — the chain would be rejected rather than accepted
 * without proof. That is the safe direction, but it is still a needless
 * restart of the runtime's own chain, so the write is atomic anyway.
 */
export async function writeChainRotationHead(
  chainDir: string,
  head: ChainRotationHead,
): Promise<void> {
  const { writeFile, rename } = await import('node:fs/promises');
  const target = `${chainDir}/${ROTATION_HEAD_FILENAME}`;
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(head, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
}
