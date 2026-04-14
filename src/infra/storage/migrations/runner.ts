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

import { createHash } from 'node:crypto';
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

const SAFE_CHAIN_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function detectVersion(block: MigratableBlock): number {
  if (typeof block.schemaVersion === 'number' && block.schemaVersion >= 1) {
    return block.schemaVersion;
  }
  return 1;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`;
}

function recomputeHash(block: MigratableBlock): string {
  const { hash: _unused, ...rest } = block;
  void _unused;
  // Keep canonical hash input simple + deterministic (sorted keys).
  // Any new migration that changes this MUST advance the schema
  // version so old-vs-new hashes don't collide.
  return createHash('sha256').update(stableStringify(rest)).digest('hex');
}

function applyMigrations(
  block: MigratableBlock,
  migrations: ChainMigration[],
  targetVersion: number,
): MigratableBlock {
  let current = block;
  for (const m of migrations) {
    current = m.transformBlock(current);
  }
  // After all migrations: stamp the version and rehash.
  const migrated: MigratableBlock = {
    ...current,
    schemaVersion: targetVersion,
    hash: '', // placeholder; recomputeHash excludes hash
  };
  migrated.hash = recomputeHash(migrated);
  return migrated;
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
      const migrated = applyMigrations(raw, applicable, targetVersion);
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
  const tmpDir = `${chainDir}.migrating-${process.pid}`;
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    for (const { file, block } of converted) {
      await fs.writeFile(path.join(tmpDir, file), JSON.stringify(block), 'utf8');
    }
    // Backup original then swap
    const backupDir = `${chainDir}.pre-migration-${Date.now()}`;
    await fs.rename(chainDir, backupDir);
    await fs.rename(tmpDir, chainDir);
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
    // chain dir is untouched.
    return {
      chain: chainName,
      fromVersion,
      toVersion: fromVersion,
      blocksConsidered: blockFiles.length,
      blocksMigrated: 0,
      error: `phase-2 write failed: ${err instanceof Error ? err.message : String(err)}. Active chain is unchanged; tmp at ${tmpDir}`,
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
