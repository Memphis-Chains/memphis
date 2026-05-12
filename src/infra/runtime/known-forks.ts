/**
 * Known-fork registry for chain integrity check tolerance.
 *
 * Background: PR #603 (2026-05-12) added a hardcoded substring match
 * for the block-1853 corruption that operator chose to keep as a
 * forensic scar rather than truncate. That fix unblocked daemon
 * restart but baked the operator's specific decision into TS source,
 * matched too loosely (block number only — any future corruption at
 * the same block would inherit the same tolerance), and produced
 * unstructured audit details.
 *
 * This module replaces the substring matcher with a structured
 * config-driven registry. Three configuration channels (most-specific
 * wins):
 *
 *   1. `<dataDir>/known-forks.json` — operator-local config (preferred).
 *      Each install owns its own list; not shared via source control.
 *   2. `MEMPHIS_KNOWN_FORK_MARKERS` env — JSON-encoded array of the
 *      same shape, for CI / test fixtures / scripted deployments.
 *   3. A baseline fallback entry for block 1853 with `chain='system'`,
 *      kept for backward-compat with operator's pre-existing install.
 *      Removed once the operator config catches up (the file ships
 *      empty by default, this is the safety net during migration).
 *
 * Matching: each `KnownFork` is keyed on `{chain, block}` (always
 * required) and `{storedPrevHash, expectedPrevHash}` (optional —
 * when present, the fork only matches if those hash fragments are
 * literal substrings of the observed error). Hash fragments are kept
 * as substrings, not full hashes, because the error formatter
 * truncates via `formatHashFingerprint()` (8 chars + ellipsis + 4
 * chars). The config can hold either the truncated form or the full
 * hex; matching tolerates both.
 *
 * Replaces `KNOWN_FORK_MARKERS: string[]` from PR #603's
 * `src/app/bootstrap.ts`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from '../../config/paths.js';

export type KnownForkKind =
  | 'prev_hash_mismatch'
  | 'stored_hash_mismatch'
  | 'non_sequential'
  | 'genesis_prev_hash';

export interface KnownFork {
  chain: string;
  block: number;
  /** Optional fingerprint of the on-disk prev_hash (matches substring). */
  storedPrevHash?: string;
  /** Optional fingerprint of what prev_hash SHOULD have been (matches substring). */
  expectedPrevHash?: string;
  /** Operator-facing reason for accepting the fork. */
  reason: string;
  /** ISO timestamp the decision was recorded. */
  acceptedAt: string;
  /** Optional PR / runbook reference. */
  ref?: string;
}

export interface ParsedIntegrityError {
  chain: string;
  block: number;
  file?: string;
  kind: KnownForkKind;
  storedPrevHash?: string;
  expectedPrevHash?: string;
}

/**
 * Baseline fallback. Encodes operator's 2026-05-12 Opcja A decision
 * for the block-1853 system-chain fork. Kept so existing installs
 * keep restarting without operator action; removed once
 * `<dataDir>/known-forks.json` is provisioned.
 */
const BASELINE_FORKS: KnownFork[] = [
  {
    chain: 'system',
    block: 1853,
    storedPrevHash: '754a7c32',
    expectedPrevHash: '4248ca68',
    reason:
      'Block 1853 prev_hash mismatch from a 2026-05-12 test escape. ' +
      'Operator chose to keep the corruption on disk as a forensic scar ' +
      'rather than truncate or renumber. Future appended blocks are sound.',
    acceptedAt: '2026-05-12T00:00:00Z',
    ref: 'PR #595 + #603, notes/system-chain-corruption-2026-05-12.md',
  },
];

function parseKnownForkArray(raw: unknown, source: string): KnownFork[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `known-forks config (${source}) must be an array of {chain, block, reason, acceptedAt, ...}`,
    );
  }
  return raw.map((entry, idx) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`known-forks[${idx}] in ${source} is not an object`);
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.chain !== 'string' || obj.chain.length === 0) {
      throw new Error(`known-forks[${idx}].chain must be a non-empty string`);
    }
    if (typeof obj.block !== 'number' || !Number.isInteger(obj.block) || obj.block < 0) {
      throw new Error(`known-forks[${idx}].block must be a non-negative integer`);
    }
    if (typeof obj.reason !== 'string' || obj.reason.length === 0) {
      throw new Error(`known-forks[${idx}].reason must be a non-empty string`);
    }
    if (typeof obj.acceptedAt !== 'string') {
      throw new Error(`known-forks[${idx}].acceptedAt must be an ISO timestamp string`);
    }
    return {
      chain: obj.chain,
      block: obj.block,
      storedPrevHash: typeof obj.storedPrevHash === 'string' ? obj.storedPrevHash : undefined,
      expectedPrevHash:
        typeof obj.expectedPrevHash === 'string' ? obj.expectedPrevHash : undefined,
      reason: obj.reason,
      acceptedAt: obj.acceptedAt,
      ref: typeof obj.ref === 'string' ? obj.ref : undefined,
    };
  });
}

/**
 * Load the known-fork registry from (in order of preference):
 *   1. `<dataDir>/known-forks.json`
 *   2. `MEMPHIS_KNOWN_FORK_MARKERS` env (JSON-encoded array)
 *   3. Built-in baseline (block 1853)
 *
 * The three sources do NOT merge — the first one that yields entries
 * wins. This keeps operator-local config authoritative and prevents
 * unintended baseline injection on installs that have explicitly
 * cleared the fork list (operator's `known-forks.json` = `[]` opts
 * out of all forks).
 */
export function loadKnownForks(rawEnv: NodeJS.ProcessEnv = process.env): KnownFork[] {
  const configPath = join(getDataDir(rawEnv), 'known-forks.json');
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8').trim();
    if (raw.length === 0) {
      return [];
    }
    return parseKnownForkArray(JSON.parse(raw), configPath);
  }
  const envRaw = rawEnv.MEMPHIS_KNOWN_FORK_MARKERS;
  if (typeof envRaw === 'string' && envRaw.trim().length > 0) {
    return parseKnownForkArray(JSON.parse(envRaw), 'MEMPHIS_KNOWN_FORK_MARKERS');
  }
  return BASELINE_FORKS;
}

/**
 * Parse a chain-integrity error message thrown by
 * `verifyChainIntegrity()` in `src/infra/storage/chain-adapter.ts`.
 *
 * The four throw sites all share a stable shape:
 *
 *   chain '<name>' integrity check failed at block <N> (<file>):
 *   prev_hash <hash> ≠ previous block's hash <hash>
 *
 *   chain '<name>' integrity check failed at block <N> (<file>):
 *   stored hash <hash> ≠ computed <hash>
 *
 *   chain '<name>' integrity check failed at block <N> (<file>):
 *   non-sequential index after block <N>
 *
 *   chain '<name>' integrity check failed at genesis block <0|1> (<file>):
 *   prev_hash <hash> ≠ expected <hash>
 *
 * Returns `null` if the message doesn't match the expected shape —
 * the caller must treat that as "unknown error, re-throw".
 */
export function parseChainIntegrityError(message: string): ParsedIntegrityError | null {
  const headerMatch = message.match(
    /^chain '([^']+)' integrity check failed at (?:genesis block|block) (\d+)(?: \(([^)]+)\))?:\s*(.+)$/s,
  );
  if (!headerMatch) return null;
  const [, chain, blockStr, file, rest] = headerMatch;
  const block = Number(blockStr);
  if (!Number.isInteger(block)) return null;

  const prevHashMatch = rest.match(/^prev_hash (\S+) ≠ previous block's hash (\S+)/);
  if (prevHashMatch) {
    return {
      chain,
      block,
      file,
      kind: 'prev_hash_mismatch',
      storedPrevHash: prevHashMatch[1],
      expectedPrevHash: prevHashMatch[2],
    };
  }

  const genesisMatch = rest.match(/^prev_hash (\S+) ≠ expected (.+?)(?:\s|$)/);
  if (genesisMatch) {
    return {
      chain,
      block,
      file,
      kind: 'genesis_prev_hash',
      storedPrevHash: genesisMatch[1],
      expectedPrevHash: genesisMatch[2],
    };
  }

  const storedHashMatch = rest.match(/^stored hash (\S+) ≠ computed (\S+)/);
  if (storedHashMatch) {
    return {
      chain,
      block,
      file,
      kind: 'stored_hash_mismatch',
      storedPrevHash: storedHashMatch[1],
      expectedPrevHash: storedHashMatch[2],
    };
  }

  if (/^non-sequential index/.test(rest)) {
    return { chain, block, file, kind: 'non_sequential' };
  }

  return null;
}

/**
 * Look up an accepted-fork entry for the parsed error. Returns the
 * matching `KnownFork` or `null` if none of the configured entries
 * cover this error.
 *
 * Matching rules:
 *   - `chain` + `block` MUST equal the error's chain + block (this is
 *     the primary key — block-1853-system can't accidentally cover
 *     block-1853-journal).
 *   - If the entry has `storedPrevHash`, the error's storedPrevHash
 *     must contain it as a substring (tolerant of fingerprint
 *     truncation). Same for `expectedPrevHash`.
 *   - If the entry has neither hash field, any hash mismatch at that
 *     `{chain, block}` pair matches (less strict, supports operators
 *     who don't have the hashes to hand).
 */
export function matchKnownFork(
  parsed: ParsedIntegrityError,
  forks: KnownFork[],
): KnownFork | null {
  for (const fork of forks) {
    if (fork.chain !== parsed.chain) continue;
    if (fork.block !== parsed.block) continue;
    if (
      fork.storedPrevHash !== undefined &&
      (parsed.storedPrevHash === undefined ||
        !parsed.storedPrevHash.includes(fork.storedPrevHash))
    ) {
      continue;
    }
    if (
      fork.expectedPrevHash !== undefined &&
      (parsed.expectedPrevHash === undefined ||
        !parsed.expectedPrevHash.includes(fork.expectedPrevHash))
    ) {
      continue;
    }
    return fork;
  }
  return null;
}

/**
 * Test-only seam for resetting any module-level cache. Currently the
 * loader is stateless (re-reads on every call), so this is a no-op,
 * but keeping the export makes future cache addition a non-breaking
 * change.
 */
export function __resetKnownForksForTests(): void {
  // intentionally empty
}
