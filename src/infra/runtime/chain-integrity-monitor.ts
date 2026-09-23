/**
 * Chain integrity monitor — continuous scan + auto-quarantine.
 *
 * Closes the 2026-09-22 incident class: non-conforming blocks (missing
 * prev_hash/hash, sidecar writer pattern) used to crash memphis at boot.
 * Today we have A2 allowlist + A3/A4 service hardening as defense; this
 * monitor ADDS proactive detection — it scans every chain periodically
 * (default hourly), validates each block, and moves bad blocks to
 * `chains/_quarantine/<chain>/<index>.<reason>.json` with a manifest.
 *
 * Output:
 *   - ScanResult returned to caller
 *   - State file: `~/.memphis/state/chain-integrity-state.json`
 *   - On issues: governance_event appended to `system` chain
 *
 * Use:
 *   import { runChainIntegrityScan } from '../infra/runtime/chain-integrity-monitor.js';
 *   const result = await runChainIntegrityScan();
 */

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hashBlock } from '../storage/chain-adapter.js';

const MEMPHIS_HOME = path.join(os.homedir(), '.memphis');
const CHAINS_DIR = path.join(MEMPHIS_HOME, 'chains');
const QUARANTINE_DIR = path.join(MEMPHIS_HOME, 'chains', '_quarantine');
const STATE_DIR = path.join(MEMPHIS_HOME, 'state');
const STATE_FILE = path.join(STATE_DIR, 'chain-integrity-state.json');

export type IntegrityIssueReason =
  | 'missing-field' // required field absent (index, timestamp, chain, prev_hash, hash, data)
  | 'invalid-hash' // recomputed hash != stored hash
  | 'broken-link' // prev_hash != previous block's hash (genesis: prev_hash='' or '0'×64)
  | 'non-conforming' // not a valid ChainBlock shape (e.g., legacy file without hash)
  | 'parse-error'; // JSON parse failed

export interface IntegrityIssue {
  chain: string;
  index: number;
  reason: IntegrityIssueReason;
  detail: string;
  file: string;
  quarantined?: string; // path to quarantine file if moved
}

export interface ScanResult {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  chainsScanned: number;
  blocksScanned: number;
  issues: IntegrityIssue[];
  quarantined: number;
}

export interface IntegrityState {
  lastScan: ScanResult | null;
  lastScanAt: string | null;
  lastOkAt: string | null;
  totalScans: number;
  totalIssues: number;
  totalQuarantined: number;
}

const REQUIRED_FIELDS = ['index', 'timestamp', 'chain', 'prev_hash', 'hash', 'data'];
const GENESIS_PREV_HASH = '0'.repeat(64);

async function loadState(): Promise<IntegrityState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw) as IntegrityState;
  } catch {
    return {
      lastScan: null,
      lastScanAt: null,
      lastOkAt: null,
      totalScans: 0,
      totalIssues: 0,
      totalQuarantined: 0,
    };
  }
}

async function saveState(state: IntegrityState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function appendSystemGovernanceEvent(issue: IntegrityIssue): Promise<void> {
  // Append to system chain — small, fire-and-forget.
  // Skip if memphis isn't running; we don't want scan to crash if it isn't.
  try {
    const dir = path.join(MEMPHIS_HOME, 'chains', 'system');
    const files = (await fs.readdir(dir))
      .filter((f) => f.endsWith('.json'))
      .sort();
    const lastIdx = files.length > 0
      ? parseInt(files[files.length - 1].replace('.json', ''), 10)
      : 0;
    const nextIdx = lastIdx + 1;
    const filename = path.join(dir, `${String(nextIdx).padStart(6, '0')}.json`);
    const block = {
      index: nextIdx,
      timestamp: new Date().toISOString(),
      chain: 'system',
      prev_hash: GENESIS_PREV_HASH,
      hash: '',
      data: {
        type: 'governance_event',
        kind: 'chain_integrity_issue',
        content: JSON.stringify({
          action: 'chain-integrity-scan.found',
          targetChain: issue.chain,
          targetIndex: issue.index,
          reason: issue.reason,
          detail: issue.detail,
          file: issue.file,
          quarantined: issue.quarantined ?? null,
        }),
        tags: ['governance_event', 'chain_integrity', issue.reason],
      },
    };
    // Compute canonical hash
    const withoutHash = { ...block, hash: undefined };
    block.hash = hashBlock(withoutHash as Parameters<typeof hashBlock>[0], crypto);
    await fs.writeFile(filename, JSON.stringify(block, null, 2), 'utf8');
  } catch (err) {
    // Silent — scan should not crash on alert write
    console.warn(`[chain-integrity-monitor] failed to append system event: ${err}`);
  }
}

async function quarantineBlock(
  issue: IntegrityIssue,
): Promise<string | null> {
  try {
    const targetDir = path.join(QUARANTINE_DIR, issue.chain);
    await fs.mkdir(targetDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = path.basename(issue.file, '.json');
    const quarantinePath = path.join(
      targetDir,
      `${baseName}.${issue.reason}.${stamp}.json`,
    );
    // Read original, write to quarantine with manifest header
    const raw = await fs.readFile(issue.file, 'utf8');
    const manifest = {
      __quarantinedAt: new Date().toISOString(),
      __quarantineReason: issue.reason,
      __quarantineDetail: issue.detail,
      __originalPath: issue.file,
      __originalContent: raw,
    };
    await fs.writeFile(quarantinePath, JSON.stringify(manifest, null, 2), 'utf8');
    // Remove original — this is what prevents chain-adapter from crashing
    await fs.unlink(issue.file);
    return quarantinePath;
  } catch (err) {
    console.warn(`[chain-integrity-monitor] quarantine failed: ${err}`);
    return null;
  }
}

/**
 * Scan all chains for integrity issues. Auto-quarantine bad blocks.
 */
export async function runChainIntegrityScan(options: {
  autoQuarantine?: boolean;
  writeAlert?: boolean;
} = {}): Promise<ScanResult> {
  const autoQuarantine = options.autoQuarantine ?? true;
  const writeAlert = options.writeAlert ?? true;
  // Hard cap to prevent cascade-quarantine: one bad genesis + 200 cascade
  // broken-link blocks would wipe a chain. Cap at 10 per scan.
  const maxQuarantinePerScan = 10;

  const startedAt = new Date().toISOString();
  const start = Date.now();

  const issues: IntegrityIssue[] = [];
  let quarantined = 0;
  let blocksScanned = 0;
  let chainsScanned = 0;
  let quarantineBudget = maxQuarantinePerScan;

  let entries: string[] = [];
  try {
    entries = await fs.readdir(CHAINS_DIR);
  } catch (err) {
    const result: ScanResult = {
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      chainsScanned: 0,
      blocksScanned: 0,
      issues: [{
        chain: '<root>',
        index: -1,
        reason: 'parse-error',
        detail: `cannot read chains dir: ${err}`,
        file: CHAINS_DIR,
      }],
      quarantined: 0,
    };
    return result;
  }

  for (const entry of entries) {
    if (entry.startsWith('_')) continue; // skip _quarantine
    const chainDir = path.join(CHAINS_DIR, entry);
    let stat;
    try {
      stat = await fs.stat(chainDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    chainsScanned++;
    let blocks: string[];
    try {
      blocks = (await fs.readdir(chainDir))
        .filter((f) => f.endsWith('.json'))
        .sort();
    } catch {
      continue;
    }

    let prevHash: string | null = null;
    for (const file of blocks) {
      blocksScanned++;
      const filePath = path.join(chainDir, file);

      let raw: string;
      let block: Record<string, unknown>;
      try {
        raw = await fs.readFile(filePath, 'utf8');
        block = JSON.parse(raw);
      } catch (err) {
        const issue: IntegrityIssue = {
          chain: entry,
          index: -1,
          reason: 'parse-error',
          detail: `JSON parse failed: ${err}`,
          file: filePath,
        };
        issues.push(issue);
        if (autoQuarantine && quarantineBudget > 0) {
          const q = await quarantineBlock(issue);
          if (q) { issue.quarantined = q; quarantined++; quarantineBudget--; }
        }
        continue;
      }

      // Check required fields
      const missing = REQUIRED_FIELDS.filter((f) => !(f in block));
      if (missing.length > 0) {
        const issue: IntegrityIssue = {
          chain: entry,
          index: block.index ?? -1,
          reason: 'missing-field',
          detail: `missing fields: ${missing.join(',')}`,
          file: filePath,
        };
        issues.push(issue);
        if (autoQuarantine && quarantineBudget > 0) {
          const q = await quarantineBlock(issue);
          if (q) { issue.quarantined = q; quarantined++; quarantineBudget--; }
          // Don't update prevHash — chain is broken at this point
          continue;
        }
      }

      // Determine if this is genesis of its chain
      // Some chains start at index 0 (legacy backup chains), some at index 1.
      // Treat the FIRST block seen (prevHash === null) with a genesis prev_hash
      // as legitimate genesis.
      const isGenesisByPrevHash = block.prev_hash === GENESIS_PREV_HASH
        || block.prev_hash === '';
      const isGenesisByIndex = block.index === 0 || block.index === 1;

      if (prevHash === null) {
        // First block of this chain
        if (!isGenesisByPrevHash && !isGenesisByIndex) {
          const issue: IntegrityIssue = {
            chain: entry,
            index: block.index ?? -1,
            reason: 'broken-link',
            detail: `expected genesis, got index=${block.index} prev_hash=${String(block.prev_hash).slice(0, 16)}...`,
            file: filePath,
          };
          issues.push(issue);
          if (autoQuarantine && quarantineBudget > 0) {
            const q = await quarantineBlock(issue);
            if (q) { issue.quarantined = q; quarantined++; quarantineBudget--; }
            continue;
          }
        }
        // For genesis: optionally verify hash recompute (catches true corruption
        // since no link to validate against). Skip non-genesis hash check because
        // legacy Rust blocks have hash computed by Rust serde_json — TS recompute
        // would mismatch valid data.
        if (block.hash && typeof block.hash === 'string' && isGenesisByPrevHash) {
          const { hash: storedHash, ...withoutHash } = block;
          try {
            const computed = hashBlock(withoutHash, crypto);
            if (computed !== storedHash) {
              const issue: IntegrityIssue = {
                chain: entry,
                index: block.index ?? -1,
                reason: 'invalid-hash',
                detail: `stored=${storedHash.slice(0, 16)}..., computed=${computed.slice(0, 16)}...`,
                file: filePath,
              };
              issues.push(issue);
              if (autoQuarantine && quarantineBudget > 0) {
                const q = await quarantineBlock(issue);
                if (q) { issue.quarantined = q; quarantined++; quarantineBudget--; }
                continue;
              }
            }
          } catch {
            // ignore — hash recompute failure on genesis is non-fatal
          }
        }
        prevHash = block.hash ?? null;
        continue;
      }

      // Non-genesis: only verify prev_hash linkage. Hash recompute is unreliable
      // for Rust-created blocks (different canonical form than TS).
      if (block.prev_hash !== prevHash) {
        const issue: IntegrityIssue = {
          chain: entry,
          index: block.index ?? -1,
          reason: 'broken-link',
          detail: `expected prev_hash=${prevHash?.slice(0, 16) ?? 'null'}..., got ${String(block.prev_hash).slice(0, 16)}...`,
          file: filePath,
        };
        issues.push(issue);
        if (autoQuarantine && quarantineBudget > 0) {
          const q = await quarantineBlock(issue);
          if (q) { issue.quarantined = q; quarantined++; quarantineBudget--; }
          continue;
        }
      }

      prevHash = block.hash ?? null;
    }
  }

  const result: ScanResult = {
    ok: issues.length === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    chainsScanned,
    blocksScanned,
    issues,
    quarantined,
  };

  // Persist state
  const prevState = await loadState();
  const newState: IntegrityState = {
    lastScan: result,
    lastScanAt: result.finishedAt,
    lastOkAt: result.ok ? result.finishedAt : prevState.lastOkAt,
    totalScans: prevState.totalScans + 1,
    totalIssues: prevState.totalIssues + issues.length,
    totalQuarantined: prevState.totalQuarantined + quarantined,
  };
  await saveState(newState);

  // Write alerts (one per issue, capped at 10)
  if (writeAlert && issues.length > 0) {
    const alertSubset = issues.slice(0, 10);
    for (const issue of alertSubset) {
      await appendSystemGovernanceEvent(issue);
    }
  }

  return result;
}

/**
 * Return last scan summary without running a new scan.
 * Used by /health and CLI.
 */
export async function getChainIntegrityState(): Promise<IntegrityState> {
  return loadState();
}