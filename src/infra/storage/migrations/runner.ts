/**
 * Chain migration runner.
 *
 * Walks every chain under `data/chains/`, reads each block file,
 * composes the applicable migrations to bring the block up to
 * CURRENT_SCHEMA_VERSION, re-hashes, and atomically writes.
 *
 * The runner is INTENTIONALLY conservative:
 *   - dry-run first to verify every block converts without error
 *   - writes to a tmp sibling directory per chain, then swaps
 *   - emits one security audit per chain + a final summary
 *   - never touches data/ if ANY chain fails in dry-run
 */

import * as nodeCrypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './registry.js';
import type {
  ChainMigration,
  MigratableBlock,
  MigrationRunOptions,
  MigrationRunResult,
  PerChainMigrationReport,
} from './types.js';
import { getChainPath } from '../../../config/paths.js';
import { writeSecurityAudit } from '../../logging/security-audit.js';
import { hashBlock } from '../chain-adapter.js';

const SAFE_CHAIN_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function detectVersion(block: MigratableBlock): number {
  if (typeof block.schemaVersion === 'number' && block.schemaVersion >= 1) {
    return block.schemaVersion;
  }
  return 1;
}

/**
 * Codex Round 6 P1 fix (PR #126): use the canonical chain-adapter
 * hashBlock so migrated blocks pass normal integrity checks
 * (diagnoseChainHashes, checkBlockHashMismatch). The old bespoke
 * stableStringify hashed the WHOLE block including schemaVersion +
 * extras, which didn't match the `{index, timestamp, chain, data,
 * prev_hash}` payload the rest of the system validates against.
 *
 * Any migration that wants to CHANGE the canonical hash input needs to
 * extend chain-adapter's hashBlock under a new schema version rather
 * than silently diverging here.
 */
function applyMigrations(
  block: MigratableBlock,
  migrations: ChainMigration[],
  targetVersion: number,
  prevHashOverride: string | null,
): MigratableBlock {
  let current = block;
  for (const m of migrations) {
    current = m.transformBlock(current);
  }
  // If a prior block in this run was migrated, its hash changed; we
  // MUST update this block's prev_hash to the new predecessor hash so
  // the chain's prev_hash linkage stays intact. (Codex Round 6 P1 fix.)
  const linkedPrevHash = prevHashOverride ?? current.prev_hash;
  const canonicalInput = {
    index: current.index,
    timestamp: current.timestamp,
    chain: current.chain,
    data: current.data,
    prev_hash: linkedPrevHash,
  };
  const newHash = hashBlock(canonicalInput, nodeCrypto);
  return {
    ...current,
    prev_hash: linkedPrevHash,
    schemaVersion: targetVersion,
    hash: newHash,
  };
}

async function listBlockFiles(
  chainDir: string,
): Promise<Array<{ file: string; index: number }>> {
  const entries = await fs.readdir(chainDir).catch(() => [] as string[]);
  return entries
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .map((f) => ({ file: f, index: Number.parseInt(f.replace('.json', ''), 10) }))
    .filter((e) => Number.isFinite(e.index))
    .sort((a, b) => a.index - b.index);
}

async function migrateChain(
  chainName: string,
  options: MigrationRunOptions,
  migrations: ChainMigration[],
  targetVersion: number,
): Promise<PerChainMigrationReport> {
  const baseDir = options.chainBaseDir ?? getChainPath(undefined, options.rawEnv);
  const chainDir = path.join(baseDir, chainName);
  const blockFiles = await listBlockFiles(chainDir);
  if (blockFiles.length === 0) {
    return {
      chain: chainName,
      fromVersion: targetVersion,
      toVersion: targetVersion,
      blocksConsidered: 0,
      blocksMigrated: 0,
      skipped: 'empty-chain',
    };
  }

  // Detect the source version from the FIRST block (all blocks in a
  // chain should share a version; we verify during the walk).
  const firstRaw = JSON.parse(
    await fs.readFile(path.join(chainDir, blockFiles[0]!.file), 'utf8'),
  ) as MigratableBlock;
  const fromVersion = detectVersion(firstRaw);
  if (fromVersion >= targetVersion) {
    return {
      chain: chainName,
      fromVersion,
      toVersion: fromVersion,
      blocksConsidered: blockFiles.length,
      blocksMigrated: 0,
      skipped: 'already-current',
    };
  }

  const applicable = migrations.filter(
    (m) => m.from >= fromVersion && m.to <= targetVersion,
  );
  if (applicable.length === 0) {
    return {
      chain: chainName,
      fromVersion,
      toVersion: fromVersion,
      blocksConsidered: blockFiles.length,
      blocksMigrated: 0,
      error: `no migration path from v${fromVersion} to v${targetVersion}`,
    };
  }

  // Phase 1: convert everything IN MEMORY — don't touch disk yet.
  const converted: Array<{ file: string; block: MigratableBlock }> = [];
  for (const entry of blockFiles) {
    const raw = JSON.parse(
      await fs.readFile(path.join(chainDir, entry.file), 'utf8'),
    ) as MigratableBlock;
    const thisVersion = detectVersion(raw);
    if (thisVersion !== fromVersion) {
      return {
        chain: chainName,
        fromVersion,
        toVersion: fromVersion,
        blocksConsidered: blockFiles.length,
        blocksMigrated: 0,
        error: `inconsistent schemaVersion within chain: first block v${fromVersion}, block ${entry.index} v${thisVersion}. Aborting to avoid corrupt state.`,
      };
    }
    try {
      // Codex Round 6 P1 fix (PR #126): thread the previous converted
      // block's NEW hash so prev_hash linkage stays intact after
      // migration. Without this, blocks 2..N still point at the
      // pre-migration hash of block 1, causing deterministic
      // prev_hash mismatches in chain verify.
      const prevHashOverride =
        converted.length === 0 ? null : converted[converted.length - 1]!.block.hash;
      const migrated = applyMigrations(raw, applicable, targetVersion, prevHashOverride);
      converted.push({ file: entry.file, block: migrated });
    } catch (err) {
      return {
        chain: chainName,
        fromVersion,
        toVersion: fromVersion,
        blocksConsidered: blockFiles.length,
        blocksMigrated: 0,
        error: `migration failed at block ${entry.index}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (options.dryRun) {
    return {
      chain: chainName,
      fromVersion,
      toVersion: targetVersion,
      blocksConsidered: blockFiles.length,
      blocksMigrated: converted.length,
    };
  }

  // Phase 2: write to tmp dir, then atomically swap.
  //
  // Codex Round 6 P2 fix (PR #126): the old code didn't handle the
  // failure mode where the FIRST rename (chain → backup) succeeds but
  // the SECOND rename (tmp → chain) fails. In that window the active
  // chain dir is GONE and reads fail until an operator manually moves
  // the backup back. The fix: track which renames we performed and
  // restore the backup if the second rename throws.
  const tmpDir = `${chainDir}.migrating-${process.pid}`;
  const backupDir = `${chainDir}.pre-migration-${Date.now()}`;
  await fs.mkdir(tmpDir, { recursive: true });
  let backupMoved = false;
  try {
    for (const { file, block } of converted) {
      await fs.writeFile(path.join(tmpDir, file), JSON.stringify(block), 'utf8');
    }
    await fs.rename(chainDir, backupDir);
    backupMoved = true;
    try {
      await fs.rename(tmpDir, chainDir);
    } catch (secondRenameErr) {
      // Second rename failed — restore backup so reads don't break.
      try {
        await fs.rename(backupDir, chainDir);
        backupMoved = false; // restored
      } catch (restoreErr) {
        throw new Error(
          `phase-2 second rename failed AND restore failed. ` +
            `original error: ${secondRenameErr instanceof Error ? secondRenameErr.message : String(secondRenameErr)}; ` +
            `restore error: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}. ` +
            `Manual recovery: \`mv ${backupDir} ${chainDir}\``,
        );
      }
      throw secondRenameErr;
    }
    writeSecurityAudit({
      action: 'chain.migration.completed',
      status: 'allowed',
      details: {
        chain: chainName,
        fromVersion,
        toVersion: targetVersion,
        blocks: converted.length,
        backup: backupDir,
      },
    });
  } catch (err) {
    // tmpDir still exists; leave it for the operator to inspect. Real
    // chain dir is untouched (either never moved, or restored above).
    return {
      chain: chainName,
      fromVersion,
      toVersion: fromVersion,
      blocksConsidered: blockFiles.length,
      blocksMigrated: 0,
      error: `phase-2 write failed: ${err instanceof Error ? err.message : String(err)}. Active chain ${backupMoved ? 'RESTORED from backup' : 'unchanged'}; tmp at ${tmpDir}`,
    };
  }

  return {
    chain: chainName,
    fromVersion,
    toVersion: targetVersion,
    blocksConsidered: blockFiles.length,
    blocksMigrated: converted.length,
  };
}

export async function runChainMigrations(
  options: MigrationRunOptions = {},
): Promise<MigrationRunResult> {
  const migrations = options.migrationsOverride ?? MIGRATIONS;
  // Target = max(CURRENT_SCHEMA_VERSION, highest `.to` in the active
  // migration set). Test overrides that push migrations further can
  // target higher versions; in production MIGRATIONS is composed to
  // land on CURRENT_SCHEMA_VERSION.
  const highestTo = migrations.reduce((m, x) => Math.max(m, x.to), CURRENT_SCHEMA_VERSION);
  const targetVersion = highestTo;
  const baseDir = options.chainBaseDir ?? getChainPath(undefined, options.rawEnv);

  let chainNames: string[];
  try {
    chainNames = (await fs.readdir(baseDir)).filter((n) => SAFE_CHAIN_NAME.test(n));
  } catch {
    return {
      ok: true,
      dryRun: options.dryRun ?? false,
      targetVersion,
      migrations: migrations.map((m) => ({
        from: m.from,
        to: m.to,
        description: m.description,
      })),
      perChain: [],
    };
  }

  const perChain: PerChainMigrationReport[] = [];
  let anyError = false;
  for (const chain of chainNames) {
    const report = await migrateChain(chain, options, migrations, targetVersion);
    perChain.push(report);
    if (report.error) anyError = true;
  }

  const result: MigrationRunResult = {
    ok: !anyError,
    dryRun: options.dryRun ?? false,
    targetVersion,
    migrations: migrations.map((m) => ({
      from: m.from,
      to: m.to,
      description: m.description,
    })),
    perChain,
  };

  if (!anyError && !options.dryRun && perChain.some((c) => c.blocksMigrated > 0)) {
    writeSecurityAudit({
      action: 'chain.migration.summary',
      status: 'allowed',
      details: {
        targetVersion,
        chainsChanged: perChain.filter((c) => c.blocksMigrated > 0).length,
        totalBlocksMigrated: perChain.reduce((s, c) => s + c.blocksMigrated, 0),
      },
    });
  }

  return result;
}

/**
 * Called from bootstrap BEFORE the HTTP server comes up. If
 * MEMPHIS_AUTO_MIGRATE_ON_BOOT=true (default false) the migrator
 * will run non-interactively. Otherwise it just reports what WOULD
 * change and leaves the decision to the operator via
 * `memphis chain migrate`.
 */
export async function maybeAutoMigrateOnBoot(
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<MigrationRunResult | null> {
  const flag = rawEnv.MEMPHIS_AUTO_MIGRATE_ON_BOOT?.trim().toLowerCase();
  const enabled = flag === 'true' || flag === '1';
  if (!enabled) return null;
  return runChainMigrations({ rawEnv, dryRun: false });
}
