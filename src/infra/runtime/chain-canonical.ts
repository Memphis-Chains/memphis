/**
 * The canonical shape of a chain block, and the one place that knows it.
 *
 * WHY A SEPARATE MODULE
 *
 * `runtime-repair.ts` already knew how to rewrite a legacy chain
 * directory: normalize the block data, re-link `prev_hash`, recompute the
 * hash, write atomically. That knowledge was private to it, which is
 * exactly why nothing else could repair a chain. Two repairs that each
 * carry their own copy of the canonical shape is two shapes.
 *
 * THE VOCABULARY IS NOT IN HERE
 *
 * There is no list of legal block types in this file, and there must not
 * be one. The legal types are whatever the native core accepts — the core
 * is a closed serde enum (`crates/memphis-core/src/block.rs:5`) and it
 * cannot enumerate itself, but it can answer the only question that
 * matters: is THIS type legal? `BlockVocabularyOracle` asks it.
 *
 * The consequence: a block whose type the core does not know is rewritten
 * into the shape the core does know — `system_event` with the original
 * semantic name in `kind` — which is the convention the repository has
 * documented since the enum was written:
 *
 *   "New writes use system_event with the original semantic name in the
 *    `kind` field of the data payload."  (block.rs:19)
 *
 * The payload itself stays in `content`, which IS covered by the hash, so
 * nothing is lost and nothing becomes mutable behind the hash's back.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeChainName } from '../../config/paths.js';
import { normalizeDecisionBlockData } from '../../core/decision-chain.js';
import { stableStringify } from '../../core/stable-stringify.js';
import {
  CANONICAL_BLOCK_TYPE,
  CANONICAL_KIND_FIELD,
  type BlockVocabulary,
} from '../storage/block-vocabulary.js';

export const GENESIS_PREV_HASH = '0'.repeat(64);

export type RawChainBlock = {
  index: number;
  timestamp: string;
  chain: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
};

/**
 * The three fields the block hash covers. Everything else in `data` is
 * passthrough: it is persisted, but it is NOT protected by the hash.
 *
 * The fallback order mirrors the native core exactly
 * (`crates/memphis-core/src/hash.rs:46`): `type`, then `block_type`, then
 * `journal`. The TS side used to skip `block_type` — a block carrying
 * only `block_type` was hashed as `journal` here and as its own type
 * there, so the two implementations disagreed about the same bytes. No
 * such block exists on this host today (measured), but the disagreement
 * is real and it is the reason the core is the oracle: two canonical
 * shapes would be two vocabularies again.
 */
export function toCanonicalHashData(data: Record<string, unknown>): {
  type: string;
  content: string;
  tags: string[];
} {
  const tags = Array.isArray(data.tags)
    ? data.tags.filter((value): value is string => typeof value === 'string')
    : [];
  const content = typeof data.content === 'string' ? data.content : JSON.stringify(data);
  const type =
    typeof data.type === 'string'
      ? data.type
      : typeof data.block_type === 'string'
        ? data.block_type
        : 'journal';
  return { type, content, tags };
}

export function canonicalHash(block: Omit<RawChainBlock, 'hash'>): string {
  const canonical = stableStringify({
    ...block,
    data: toCanonicalHashData(block.data),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Parse a block file without judging it. A block that is not JSON, or has
 * no `data`, cannot be repaired — the caller has to say so rather than
 * guess.
 */
export function parseRawChainBlock(payload: string): RawChainBlock | null {
  try {
    const parsed = JSON.parse(payload) as Partial<RawChainBlock>;
    if (
      typeof parsed.index !== 'number' ||
      typeof parsed.timestamp !== 'string' ||
      typeof parsed.chain !== 'string' ||
      typeof parsed.prev_hash !== 'string' ||
      typeof parsed.hash !== 'string' ||
      typeof parsed.data !== 'object' ||
      parsed.data === null ||
      Array.isArray(parsed.data)
    ) {
      return null;
    }
    return {
      index: parsed.index,
      timestamp: parsed.timestamp,
      chain: parsed.chain,
      data: parsed.data,
      prev_hash: parsed.prev_hash,
      hash: parsed.hash,
    };
  } catch {
    return null;
  }
}

/**
 * The type a block should carry.
 *
 * The declared type is `data.type`, then the legacy alias `data.block_type`.
 * `data.kind` is NOT a type source: under the canonical convention `kind`
 * is the semantic name that travels WITH `system_event`, and promoting it
 * to a type is how a block ended up claiming a type the core does not
 * know.
 *
 * With no vocabulary oracle this keeps the historical behaviour for a
 * declared type — it is preserved verbatim.
 *
 * WITH an oracle, one thing changes: a type the native core cannot
 * deserialize is not a legal type, so it becomes `system_event` and the
 * original name moves to `kind`. That is the only difference, and it is
 * the whole point of this stage.
 */
export function inferBlockType(
  chainName: string,
  data: Record<string, unknown>,
  vocabulary?: BlockVocabulary,
): string {
  const declared = firstNonEmptyString(data.type, data.block_type);
  if (declared) {
    if (!vocabulary) return declared;
    if (vocabulary.isKnown(declared)) return declared;
    return CANONICAL_BLOCK_TYPE;
  }
  switch (normalizeChainName(chainName) ?? chainName) {
    case 'decisions':
      return 'decision';
    case 'reflections':
      return 'reflection';
    case 'patterns':
      return 'pattern';
    case 'cases':
      return 'case';
    case 'system':
      return 'system';
    default:
      return 'journal';
  }
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function inferBlockContent(data: Record<string, unknown>): string {
  const candidates = [
    data.content,
    data.message,
    data.summary,
    data.title,
    data.text,
    data.note,
    data.description,
    data.purpose,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return JSON.stringify(data);
}

export function normalizeTags(data: Record<string, unknown>, fallback: string[] = []): string[] {
  const tags = Array.isArray(data.tags)
    ? data.tags.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      )
    : typeof data.tags === 'string'
      ? data.tags
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
  return Array.from(new Set(tags.length > 0 ? tags : fallback));
}

export interface NormalizeBlockOptions {
  /** When given, an unknown type is rewritten into the canonical shape. */
  readonly vocabulary?: BlockVocabulary;
}

/**
 * Bring one block's `data` into the canonical shape: a type, a content
 * string, a string array of tags, and every other field passed through.
 */
export function normalizeBlockData(
  chainName: string,
  data: Record<string, unknown>,
  options: NormalizeBlockOptions = {},
): Record<string, unknown> {
  const normalizedChain = normalizeChainName(chainName) ?? chainName;
  if (normalizedChain === 'decisions') {
    return normalizeDecisionBlockData(data, {
      source: typeof data.source === 'string' ? data.source : 'legacy-migration',
      fallbackTags: ['decision', 'legacy-migrated'],
    });
  }

  const passthrough = Object.fromEntries(
    Object.entries(data).filter(
      ([key]) => !['type', 'block_type', 'content', 'tags'].includes(key),
    ),
  );
  const declaredType = firstNonEmptyString(data.type, data.block_type);
  const existingKind = firstNonEmptyString(data.kind);
  const type = inferBlockType(normalizedChain, data, options.vocabulary);

  // The original semantic name moves into `kind` when the type had to be
  // replaced — otherwise the rewrite would lose what the block WAS. An
  // existing `kind` is never overwritten: it is the name the block
  // already carries.
  const needsKind =
    type === CANONICAL_BLOCK_TYPE && declaredType !== null && declaredType !== CANONICAL_BLOCK_TYPE;
  const kind = needsKind && existingKind === null ? { [CANONICAL_KIND_FIELD]: declaredType } : {};

  return {
    ...passthrough,
    ...kind,
    type,
    content: inferBlockContent(data),
    tags: normalizeTags(data, ['legacy-migrated']),
  };
}

export interface RewriteChainOptions {
  readonly vocabulary?: BlockVocabulary;
}

/**
 * Rewrite a chain directory into the canonical shape: normalized data,
 * re-linked `prev_hash`, recomputed hash, atomic write.
 *
 * Returns the number of blocks that were actually changed. A directory
 * whose blocks cannot be parsed is skipped, with a warning — a repair that
 * guesses is worse than a repair that refuses.
 */
export function rewriteChainDirectory(
  chainName: string,
  chainDir: string,
  applied: string[],
  warnings: string[],
  options: RewriteChainOptions = {},
): number {
  if (!existsSync(chainDir)) return 0;

  const files = readdirSync(chainDir)
    .filter((entry) => /^\d+\.json$/.test(entry))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) return 0;

  const normalizedChain = normalizeChainName(chainName) ?? chainName;
  const blocks = files.map((file) => ({
    file,
    absolutePath: join(chainDir, file),
    raw: parseRawChainBlock(readFileSync(join(chainDir, file), 'utf8')),
  }));

  if (blocks.some((entry) => entry.raw === null)) {
    warnings.push(`legacy repair skipped unreadable chain directory ${chainDir}`);
    return 0;
  }

  let rewritten = 0;
  let previousHash = blocks[0]!.raw!.prev_hash || GENESIS_PREV_HASH;
  const nextBlocks = blocks.map((entry, index) => {
    const current = entry.raw!;
    const normalizedData = normalizeBlockData(normalizedChain, current.data, {
      vocabulary: options.vocabulary,
    });
    const prevHash = index === 0 ? previousHash : previousHash;
    const nextWithoutHash = {
      index: current.index,
      timestamp: current.timestamp,
      chain: normalizedChain,
      data: normalizedData,
      prev_hash: prevHash,
    };
    const nextHash = canonicalHash(nextWithoutHash);
    previousHash = nextHash;

    const dataChanged = JSON.stringify(current.data) !== JSON.stringify(normalizedData);
    const chainChanged = current.chain !== normalizedChain;
    const prevHashChanged = current.prev_hash !== prevHash;
    const hashChanged = current.hash !== nextHash;
    if (dataChanged || chainChanged || prevHashChanged || hashChanged) {
      rewritten += 1;
    }

    return {
      file: entry.file,
      payload: { ...nextWithoutHash, hash: nextHash },
    };
  });

  if (rewritten === 0) return 0;

  for (const block of nextBlocks) {
    const target = join(chainDir, block.file);
    const tmp = `${target}.repair-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(block.payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, target);
  }

  applied.push(`normalized legacy chain blocks in ${chainDir} (${rewritten}/${files.length})`);
  return rewritten;
}

/**
 * A block the native core cannot read, located precisely.
 */
export interface UnreadableBlockLocation {
  /** The logical chain (an archive's directory name is not the chain). */
  readonly chain: string;
  /** The directory name on disk. */
  readonly directory: string;
  /** The file inside it. */
  readonly file: string;
  /** The block's declared type, when it has one. */
  readonly type?: string;
  /** What the core said. */
  readonly error: string;
}

/**
 * Why one block has to be rewritten.
 *
 * The three reasons are exactly the three ways the core's `BlockData`
 * (`crates/memphis-core/src/block.rs:45`) can refuse a block: an unknown
 * type, a missing type, and a missing `content`/`tags` field.
 */
export function blockNeedsVocabularyRepair(
  data: Record<string, unknown>,
  vocabulary: BlockVocabulary,
): { needsRepair: boolean; reason?: string } {
  const declared = firstNonEmptyString(data.type, data.block_type);
  if (declared === null) {
    return { needsRepair: true, reason: 'the block carries no type' };
  }
  const verdict = vocabulary.verdict(declared);
  if (!verdict.known) {
    return { needsRepair: true, reason: verdict.error ?? `unknown type "${declared}"` };
  }
  if (typeof data.content !== 'string') {
    return { needsRepair: true, reason: 'the block carries no content' };
  }
  if (!Array.isArray(data.tags) || data.tags.some((tag) => typeof tag !== 'string')) {
    return { needsRepair: true, reason: 'the block carries no string tags' };
  }
  return { needsRepair: false };
}

export interface VocabularyRewriteOptions {
  readonly vocabulary: BlockVocabulary;
}

/**
 * Rewrite ONLY the blocks the native core cannot read, and re-link the
 * hash chain from the first of them onward.
 *
 * Why not the whole directory: the legacy rewrite normalizes every block
 * it touches, and on this host that would mean rewriting 23 391 blocks
 * to fix two. A repair that rewrites history it did not have to rewrite
 * is a repair nobody can audit.
 *
 * Why the hash cascade is unavoidable: a block's hash covers
 * `prev_hash`, so changing block N changes block N+1's `prev_hash`, and
 * so on to the end of the chain. The chain stays internally consistent;
 * the bytes before the first repaired block are untouched.
 *
 * The `chain` field of a block is NOT rewritten — it is hashed as it
 * stands. An archive's blocks carry the chain they were written under
 * (`journal`), and rewriting that field would invalidate every hash in
 * the archive for no reason.
 */
export function repairChainDirectoryVocabulary(
  chainName: string,
  chainDir: string,
  applied: string[],
  warnings: string[],
  options: VocabularyRewriteOptions,
): { blocksRewritten: number; repairedFiles: string[] } {
  if (!existsSync(chainDir)) return { blocksRewritten: 0, repairedFiles: [] };

  const files = readdirSync(chainDir)
    .filter((entry) => /^\d+\.json$/.test(entry))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) return { blocksRewritten: 0, repairedFiles: [] };

  const parsed = files.map((file) => ({
    file,
    raw: parseRawChainBlock(readFileSync(join(chainDir, file), 'utf8')),
  }));

  const unreadable = parsed.filter((entry) => entry.raw === null);
  if (unreadable.length > 0) {
    warnings.push(
      `vocabulary repair skipped ${chainDir}: ${unreadable.length} file(s) are not readable blocks (${unreadable
        .map((entry) => entry.file)
        .join(', ')})`,
    );
    return { blocksRewritten: 0, repairedFiles: [] };
  }

  const blocks = parsed.map((entry) => entry.raw!);
  const repairs = blocks.map((block) => blockNeedsVocabularyRepair(block.data, options.vocabulary));
  const firstRepaired = repairs.findIndex((entry) => entry.needsRepair);
  if (firstRepaired === -1) return { blocksRewritten: 0, repairedFiles: [] };

  const repairedFiles: string[] = [];
  let previousHash = blocks[0]!.prev_hash || GENESIS_PREV_HASH;
  const payloads: { file: string; payload: RawChainBlock }[] = [];

  for (const [index, entry] of blocks.entries()) {
    const current = entry;
    const data = repairs[index]!.needsRepair
      ? normalizeBlockData(chainName, current.data, { vocabulary: options.vocabulary })
      : current.data;
    const prevHash = index === 0 ? previousHash : previousHash;
    const withoutHash = {
      index: current.index,
      timestamp: current.timestamp,
      chain: current.chain,
      data,
      prev_hash: prevHash,
    };
    const hash = canonicalHash(withoutHash);
    previousHash = hash;

    const changed =
      JSON.stringify(current.data) !== JSON.stringify(data) ||
      current.prev_hash !== prevHash ||
      current.hash !== hash;
    if (changed) repairedFiles.push(files[index]!);

    payloads.push({ file: files[index]!, payload: { ...withoutHash, hash } });
  }

  // Only the tail from the first repaired block is written: the blocks
  // before it are byte-identical and must stay that way.
  const firstChanged = repairedFiles.length > 0 ? files.indexOf(repairedFiles[0]!) : -1;
  for (const entry of payloads.slice(Math.max(firstChanged, 0))) {
    const target = join(chainDir, entry.file);
    const tmp = `${target}.repair-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(entry.payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, target);
  }

  applied.push(
    `rewrote ${repairedFiles.length} block(s) in ${chainDir} into the core's vocabulary (from ${repairedFiles[0]})`,
  );
  return { blocksRewritten: repairedFiles.length, repairedFiles };
}
