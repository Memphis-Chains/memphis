import {
  createHash,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
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
  getReadableChainPaths,
  normalizeChainName,
} from '../../config/paths.js';
import { normalizeDecisionBlockData } from '../../core/decision-chain.js';
import { stableStringify } from '../../core/stable-stringify.js';
import {
  loadFirstRunRecord,
  recordLegacyRuntimeAdoption,
  scanLegacyChainState,
} from '../../onboarding/first-run.js';
import type { AppConfig } from '../config/schema.js';
import { envSchema } from '../config/schema.js';
import { rebuildExactSearchIndex } from '../memory/exact-search.js';
import { createSqliteClient, runMigrations } from '../storage/sqlite/client.js';

const APPEND_LOCK_STALE_MS = 30_000;
const GENESIS_PREV_HASH = '0'.repeat(64);

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

type RawChainBlock = {
  index: number;
  timestamp: string;
  chain: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
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

function inferBlockType(chainName: string, data: Record<string, unknown>): string {
  if (typeof data.type === 'string' && data.type.trim().length > 0) return data.type.trim();
  if (typeof data.block_type === 'string' && data.block_type.trim().length > 0) {
    return data.block_type.trim();
  }
  if (typeof data.kind === 'string' && data.kind.trim().length > 0) return data.kind.trim();
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

function inferBlockContent(data: Record<string, unknown>): string {
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

function normalizeTags(data: Record<string, unknown>, fallback: string[] = []): string[] {
  const tags = Array.isArray(data.tags)
    ? data.tags.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : typeof data.tags === 'string'
      ? data.tags
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
  return Array.from(new Set(tags.length > 0 ? tags : fallback));
}

function normalizeBlockData(chainName: string, data: Record<string, unknown>): Record<string, unknown> {
  const normalizedChain = normalizeChainName(chainName) ?? chainName;
  if (normalizedChain === 'decisions') {
    return normalizeDecisionBlockData(data, {
      source: typeof data.source === 'string' ? data.source : 'legacy-migration',
      fallbackTags: ['decision', 'legacy-migrated'],
    });
  }

  const passthrough = Object.fromEntries(
    Object.entries(data).filter(([key]) => !['type', 'block_type', 'content', 'tags'].includes(key)),
  );
  return {
    ...passthrough,
    type: inferBlockType(normalizedChain, data),
    content: inferBlockContent(data),
    tags: normalizeTags(data, ['legacy-migrated']),
  };
}

function parseRawChainBlock(payload: string): RawChainBlock | null {
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

function toCanonicalHashData(data: Record<string, unknown>): { type: string; content: string; tags: string[] } {
  const tags = Array.isArray(data.tags)
    ? data.tags.filter((value): value is string => typeof value === 'string')
    : [];
  const content = typeof data.content === 'string' ? data.content : JSON.stringify(data);
  const type = typeof data.type === 'string' ? data.type : 'journal';
  return { type, content, tags };
}

function canonicalHash(block: Omit<RawChainBlock, 'hash'>): string {
  const canonical = stableStringify({
    ...block,
    data: toCanonicalHashData(block.data),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function rewriteLegacyChainDirectory(
  chainName: string,
  chainDir: string,
  applied: string[],
  warnings: string[],
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
    const normalizedData = normalizeBlockData(normalizedChain, current.data);
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
      payload: {
        ...nextWithoutHash,
        hash: nextHash,
      },
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

function normalizeLegacyRuntimeState(
  snapshot: RuntimeHealthSnapshot,
  rawEnv: NodeJS.ProcessEnv,
  applied: string[],
  warnings: string[],
): void {
  if (snapshot.firstRun.state !== 'legacy-migrateable') {
    return;
  }

  const legacyScan = scanLegacyChainState(rawEnv);
  const migratedChains = new Set<string>();
  let migratedBlocks = 0;

  for (const chainName of legacyScan.chains) {
    for (const chainDir of getReadableChainPaths(chainName, rawEnv)) {
      const rewritten = rewriteLegacyChainDirectory(chainName, chainDir, applied, warnings);
      if (rewritten > 0) {
        migratedChains.add(normalizeChainName(chainName) ?? chainName);
        migratedBlocks += rewritten;
      }
    }
  }

  if (!loadFirstRunRecord(rawEnv)) {
    const adoptedChains =
      snapshot.chainMemory.activeChains.length > 0
        ? snapshot.chainMemory.activeChains
        : legacyScan.chains.length > 0
          ? legacyScan.chains
          : ['journal'];
    const record = recordLegacyRuntimeAdoption(
      {
        summary:
          migratedChains.size > 0
            ? 'Legacy runtime was normalized during repair. Existing chain history was adopted explicitly so Memphis no longer invents a hidden first-run state.'
            : 'Existing local runtime state predates the controlled first-run contract. Memphis recorded an explicit legacy adoption marker during repair without inventing new soul or identity state.',
        createdChains: adoptedChains,
        createdBlocks: snapshot.chainMemory.totalBlocks,
        legacyChains: legacyScan.chains,
      },
      rawEnv,
    );
    applied.push(
      `recorded explicit first-run adoption marker (${record.origin ?? 'legacy-repair'}) for legacy runtime state`,
    );
  }

  if (migratedBlocks > 0) {
    applied.push(
      `legacy runtime normalization completed for ${migratedChains.size} chain(s), rewritten blocks=${migratedBlocks}`,
    );
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
  normalizeLegacyRuntimeState(before, rawEnv, applied, warnings);

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
