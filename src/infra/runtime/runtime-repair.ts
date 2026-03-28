import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { buildRuntimeHealthSnapshot, type RuntimeHealthSnapshot } from './runtime-health.js';
import { ModelC_PredictivePatterns } from '../../cognitive/model-c.js';
import { loadCognitiveBlocks } from '../../cognitive/runtime-support.js';
import {
  getBackupPath,
  getChainPath,
  getDataDir,
  getEmbeddingPath,
  getVaultPath,
} from '../../config/paths.js';
import type { AppConfig } from '../config/schema.js';
import { envSchema } from '../config/schema.js';
import { rebuildExactSearchIndex } from '../memory/exact-search.js';
import { createSqliteClient, runMigrations } from '../storage/sqlite/client.js';

const APPEND_LOCK_STALE_MS = 30_000;

export type RuntimeRepairResult = {
  ok: boolean;
  status: RuntimeHealthSnapshot['repair']['status'];
  repairable: boolean;
  recommendedAction: string;
  applied: string[];
  skipped: string[];
  warnings: string[];
  before: RuntimeHealthSnapshot;
  after: RuntimeHealthSnapshot;
};

export type RuntimeRepairOptions = {
  rawEnv?: NodeJS.ProcessEnv;
  force?: boolean;
};

function resolveRuntimeConfig(
  rawEnv: NodeJS.ProcessEnv,
): Pick<AppConfig, 'DATABASE_URL' | 'DEFAULT_PROVIDER' | 'LOCAL_FALLBACK_ENABLED'> {
  const parsed = envSchema.safeParse(rawEnv);
  if (parsed.success) {
    return parsed.data;
  }

  return {
    DATABASE_URL: rawEnv.DATABASE_URL?.trim() || 'file:./data/memphis.db',
    DEFAULT_PROVIDER: 'local-fallback',
    LOCAL_FALLBACK_ENABLED: rawEnv.LOCAL_FALLBACK_ENABLED !== 'false',
  };
}

function resolveSqlitePath(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith('file:')) return null;
  return resolve(databaseUrl.replace(/^file:/, ''));
}

async function withScopedEnv<T>(
  rawEnv: NodeJS.ProcessEnv,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(rawEnv)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function ensureDir(path: string, applied: string[]): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    applied.push(`created ${path}`);
  }
}

function ensureRuntimeLayout(
  rawEnv: NodeJS.ProcessEnv,
  config: Pick<AppConfig, 'DATABASE_URL'>,
  applied: string[],
): void {
  for (const dir of [
    getDataDir(rawEnv),
    getChainPath(undefined, rawEnv),
    getEmbeddingPath(rawEnv),
    getVaultPath(rawEnv),
    getBackupPath(rawEnv),
    join(getDataDir(rawEnv), 'config'),
  ]) {
    ensureDir(dir, applied);
  }

  const dbPath = resolveSqlitePath(config.DATABASE_URL);
  if (dbPath) {
    ensureDir(dirname(dbPath), applied);
  }
}

function initializeSqlite(
  config: Pick<AppConfig, 'DATABASE_URL'>,
  applied: string[],
  skipped: string[],
): void {
  const databasePath = resolveSqlitePath(config.DATABASE_URL);
  if (!databasePath) {
    skipped.push('sqlite initialization skipped: DATABASE_URL is not file-backed');
    return;
  }

  try {
    const db = createSqliteClient(config.DATABASE_URL);
    try {
      runMigrations(db);
    } finally {
      db.close();
    }
    applied.push(`initialized sqlite runtime database at ${databasePath}`);
  } catch (error) {
    skipped.push(
      `sqlite initialization skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function removeStaleRuntimeArtifacts(rawEnv: NodeJS.ProcessEnv, applied: string[]): void {
  const memphisDir = getDataDir(rawEnv);
  if (!existsSync(memphisDir)) return;

  for (const entry of readdirSync(memphisDir)) {
    const target = join(memphisDir, entry);
    if (!entry.endsWith('.lock') && !entry.endsWith('.pid')) continue;

    try {
      const raw = readFileSync(target, 'utf8').trim();
      const pid = Number.parseInt(raw, 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        rmSync(target, { force: true });
        applied.push(`removed stale runtime marker ${target}`);
        continue;
      }

      try {
        process.kill(pid, 0);
      } catch {
        rmSync(target, { force: true });
        applied.push(`removed stale runtime marker ${target}`);
      }
    } catch {
      rmSync(target, { force: true });
      applied.push(`removed unreadable runtime marker ${target}`);
    }
  }

  const chainsRoot = getChainPath(undefined, rawEnv);
  if (!existsSync(chainsRoot)) return;
  for (const chainName of readdirSync(chainsRoot)) {
    const chainDir = join(chainsRoot, chainName);
    let stats;
    try {
      stats = statSync(chainDir);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;

    for (const entry of readdirSync(chainDir)) {
      if (!entry.endsWith('.lock')) continue;
      const target = join(chainDir, entry);
      try {
        const lockStats = statSync(target);
        if (Date.now() - lockStats.mtimeMs > APPEND_LOCK_STALE_MS) {
          rmSync(target, { force: true });
          applied.push(`removed stale chain lock ${target}`);
        }
      } catch {
        rmSync(target, { force: true });
        applied.push(`removed unreadable chain lock ${target}`);
      }
    }
  }
}

function rebuildExactSearchIfSafe(
  snapshot: RuntimeHealthSnapshot,
  rawEnv: NodeJS.ProcessEnv,
  applied: string[],
  skipped: string[],
): void {
  if (snapshot.chainMemory.integrity.status === 'degraded') {
    skipped.push('exact-search rebuild skipped: canonical chain integrity is degraded');
    return;
  }

  if (!snapshot.exactSearch.repairable && snapshot.exactSearch.status !== 'indexed') {
    skipped.push(snapshot.exactSearch.recommendedAction);
    return;
  }

  if (snapshot.exactSearch.status === 'indexed' && snapshot.exactSearch.entries > 0) {
    return;
  }

  const result = rebuildExactSearchIndex({}, rawEnv);
  applied.push(
    `rebuilt exact-search index (${result.indexed} indexed, ${result.skipped} skipped, chains=${result.chains.join(', ') || 'none'})`,
  );
}

async function rebuildPatternsIfSafe(
  snapshot: RuntimeHealthSnapshot,
  rawEnv: NodeJS.ProcessEnv,
  applied: string[],
  skipped: string[],
): Promise<void> {
  const legacyPatternStoragePath = join(getDataDir(rawEnv), 'patterns.json');
  if (existsSync(legacyPatternStoragePath)) {
    rmSync(legacyPatternStoragePath, { force: true });
    applied.push(`removed legacy pattern cache ${legacyPatternStoragePath}`);
  }

  if (snapshot.cognition.persistenceStatus !== 'degraded') {
    return;
  }

  if (!snapshot.cognition.repairable) {
    skipped.push(snapshot.cognition.recommendedAction);
    return;
  }

  const patternsChainDir = getChainPath('patterns', rawEnv);

  if (snapshot.cognition.patternsChain.invalid > 0 && existsSync(patternsChainDir)) {
    rmSync(patternsChainDir, { recursive: true, force: true });
    applied.push(`removed degraded patterns chain ${patternsChainDir}`);
  }

  if (!snapshot.chainMemory.cognitiveReady) {
    applied.push('left patterns lane empty because no canonical cognitive history exists yet');
    return;
  }

  const blocks = await withScopedEnv(rawEnv, () => loadCognitiveBlocks());
  if (blocks.length === 0) {
    applied.push('left patterns lane empty because no cognitive blocks were available to rebuild');
    return;
  }

  await withScopedEnv(rawEnv, async () => {
    const learner = new ModelC_PredictivePatterns(blocks);
    await learner.learn();
  });
  applied.push('rebuilt derived pattern state from canonical chain history');
}

export async function repairRuntimeState(
  options: RuntimeRepairOptions = {},
): Promise<RuntimeRepairResult> {
  const rawEnv = options.rawEnv ?? process.env;
  const config = resolveRuntimeConfig(rawEnv);
  const applied: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  const before = await buildRuntimeHealthSnapshot(config, rawEnv);

  ensureRuntimeLayout(rawEnv, config, applied);
  removeStaleRuntimeArtifacts(rawEnv, applied);
  initializeSqlite(config, applied, skipped);

  if (before.repair.status !== 'degraded-manual' || options.force) {
    rebuildExactSearchIfSafe(before, rawEnv, applied, skipped);
    await rebuildPatternsIfSafe(before, rawEnv, applied, skipped);
  } else {
    skipped.push(before.repair.recommendedAction);
  }

  const after = await buildRuntimeHealthSnapshot(config, rawEnv);

  if (after.repair.status === 'degraded-manual') {
    warnings.push(after.repair.recommendedAction);
  }

  return {
    ok: after.repair.status !== 'degraded-manual',
    status: after.repair.status,
    repairable: after.repair.repairable,
    recommendedAction: after.repair.recommendedAction,
    applied,
    skipped,
    warnings,
    before,
    after,
  };
}
