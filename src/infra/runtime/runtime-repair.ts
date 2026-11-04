/* eslint-disable no-restricted-syntax */
//
// Runtime repair — does dynamic process.env writes (`process.env[key]`)
// for env-rollback during repair attempts. The keys aren't statically
// known (operator config under inspection), so typed accessors aren't
// applicable. File-level disable.
//
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type Database from 'better-sqlite3';

import { rewriteChainDirectory } from './chain-canonical.js';
import { repairChainVocabulary, scanChainVocabulary } from './chain-vocabulary-repair.js';
import { buildRuntimeHealthSnapshot, type RuntimeHealthSnapshot } from './runtime-health.js';
import { loadCognitiveConfig } from '../../cognitive/config-loader.js';
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
import {
  normalizeConversationId,
  resolveLocalActorId,
} from '../../gateway/conversation-identity.js';
import {
  loadFirstRunRecord,
  recordLegacyRuntimeAdoption,
  scanLegacyChainState,
} from '../../onboarding/first-run.js';
import type { AppConfig } from '../config/schema.js';
import { envSchema } from '../config/schema.js';
import { rebuildDerivedEmbeddings } from '../memory/embed-reindex.js';
import { rebuildExactSearchIndex } from '../memory/exact-search.js';
import type { BlockVocabulary } from '../storage/block-vocabulary.js';
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
  /**
   * Report what WOULD change, and write nothing.
   *
   * A dry run answers the question the operator asks before consenting:
   * what exactly would this change? It needs no passphrase, because it
   * rewrites nothing.
   */
  dryRun?: boolean;
  /**
   * The vocabulary to ask. Defaults to the native core.
   *
   * Injectable so a test can ask a question without the bridge — the
   * core is the oracle in production and a stand-in in a test, and the
   * repair must behave the same either way.
   */
  vocabulary?: BlockVocabulary;
  /**
   * Asked for when the repair would REWRITE CHAIN HISTORY.
   *
   * Rewriting a block changes a hash chain that exists to make history
   * tamper-evident. That is a tier-2 operation, so it needs the
   * operator's consent, and the consent is the caller's to obtain (the
   * CLI answers this with the operator gate — a passphrase asked for
   * once, interactively).
   *
   * The callback is only invoked when there is something to rewrite.
   * Everything else this repair does — creating directories, initialising
   * SQLite, rebuilding derived indexes — is reversible or derived, and
   * stays ungated.
   */
  authorizeHistoryRewrite?: () => Promise<boolean>;
};

type SqliteSessionRow = {
  created_at: string;
  updated_at: string;
};

type SqliteOperatorChatMigrationRow = {
  sequence: number;
  role: string;
  content: string;
  display_content: string;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_calls_json: string | null;
  provider: string | null;
  model: string | null;
  created_at: string;
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

async function withScopedEnv<T>(rawEnv: NodeJS.ProcessEnv, fn: () => Promise<T> | T): Promise<T> {
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
      const rewritten = rewriteChainDirectory(chainName, chainDir, applied, warnings);
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

function selectSessionRow(db: Database.Database, sessionId: string): SqliteSessionRow | undefined {
  return db.prepare('SELECT created_at, updated_at FROM sessions WHERE id = ?').get(sessionId) as
    | SqliteSessionRow
    | undefined;
}

function selectOperatorChatRows(
  db: Database.Database,
  sessionId: string,
): SqliteOperatorChatMigrationRow[] {
  return db
    .prepare(
      `SELECT sequence, role, content, display_content, tool_call_id, tool_name, tool_calls_json, provider, model, created_at
       FROM operator_chat_messages
       WHERE session_id = ?
       ORDER BY created_at ASC, sequence ASC`,
    )
    .all(sessionId) as SqliteOperatorChatMigrationRow[];
}

function countGenerationEvents(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM generation_events WHERE session_id = ?')
    .get(sessionId) as { count: number };
  return row.count;
}

function mergeOperatorChatRows(
  targetRows: SqliteOperatorChatMigrationRow[],
  sourceRows: SqliteOperatorChatMigrationRow[],
): SqliteOperatorChatMigrationRow[] {
  return [...targetRows, ...sourceRows]
    .sort(
      (left, right) =>
        left.created_at.localeCompare(right.created_at) || left.sequence - right.sequence,
    )
    .map((row, index) => ({
      ...row,
      sequence: index + 1,
    }));
}

function migrateSqliteConversationSession(
  db: Database.Database,
  fromSessionId: string,
  toSessionId: string,
): { migrated: boolean; messagesMoved: number; eventsMoved: number } {
  if (fromSessionId === toSessionId) {
    return { migrated: false, messagesMoved: 0, eventsMoved: 0 };
  }

  const tx = db.transaction(() => {
    const fromSession = selectSessionRow(db, fromSessionId);
    const toSession = selectSessionRow(db, toSessionId);
    const fromMessages = selectOperatorChatRows(db, fromSessionId);
    const toMessages = selectOperatorChatRows(db, toSessionId);
    const eventsMoved = countGenerationEvents(db, fromSessionId);

    if (!fromSession && fromMessages.length === 0 && eventsMoved === 0) {
      return { migrated: false, messagesMoved: 0, eventsMoved: 0 };
    }

    const mergedMessages = mergeOperatorChatRows(toMessages, fromMessages);
    const now = new Date().toISOString();
    const createdAtCandidates = [
      fromSession?.created_at,
      toSession?.created_at,
      mergedMessages[0]?.created_at,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const updatedAtCandidates = [
      fromSession?.updated_at,
      toSession?.updated_at,
      ...mergedMessages.map((row) => row.created_at),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const createdAt =
      createdAtCandidates.sort((left, right) => left.localeCompare(right))[0] ?? now;
    const updatedAt =
      updatedAtCandidates.sort((left, right) => right.localeCompare(left))[0] ?? now;

    db.prepare(
      `INSERT INTO sessions(id, created_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, updated_at = excluded.updated_at`,
    ).run(toSessionId, createdAt, updatedAt);

    db.prepare('DELETE FROM operator_chat_messages WHERE session_id = ?').run(toSessionId);
    db.prepare('DELETE FROM operator_chat_messages WHERE session_id = ?').run(fromSessionId);

    if (mergedMessages.length > 0) {
      const insert = db.prepare(
        `INSERT INTO operator_chat_messages (
           session_id, sequence, role, content, display_content, tool_call_id, tool_name, tool_calls_json, provider, model, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of mergedMessages) {
        insert.run(
          toSessionId,
          row.sequence,
          row.role,
          row.content,
          row.display_content,
          row.tool_call_id,
          row.tool_name,
          row.tool_calls_json,
          row.provider,
          row.model,
          row.created_at,
        );
      }
    }

    if (eventsMoved > 0) {
      db.prepare('UPDATE generation_events SET session_id = ? WHERE session_id = ?').run(
        toSessionId,
        fromSessionId,
      );
    }

    db.prepare('DELETE FROM sessions WHERE id = ?').run(fromSessionId);
    db.prepare('UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?').run(
      createdAt,
      updatedAt,
      toSessionId,
    );

    return {
      migrated: true,
      messagesMoved: fromMessages.length,
      eventsMoved,
    };
  });

  return tx();
}

function normalizeConversationSessions(
  config: Pick<AppConfig, 'DATABASE_URL'>,
  rawEnv: NodeJS.ProcessEnv,
  applied: string[],
  skipped: string[],
): void {
  const databasePath = resolveSqlitePath(config.DATABASE_URL);
  if (!databasePath || !existsSync(databasePath)) {
    return;
  }

  const localActorId = resolveLocalActorId(rawEnv);
  const db = createSqliteClient(config.DATABASE_URL);
  try {
    runMigrations(db);
    const sessionIds = new Set<string>();
    for (const row of db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>) {
      sessionIds.add(row.id);
    }
    for (const row of db
      .prepare('SELECT DISTINCT session_id AS id FROM operator_chat_messages')
      .all() as Array<{ id: string }>) {
      sessionIds.add(row.id);
    }
    for (const row of db
      .prepare(
        'SELECT DISTINCT session_id AS id FROM generation_events WHERE session_id IS NOT NULL',
      )
      .all() as Array<{ id: string }>) {
      sessionIds.add(row.id);
    }

    for (const sessionId of [...sessionIds].sort((left, right) => left.localeCompare(right))) {
      const canonicalSessionId = normalizeConversationId(sessionId, localActorId, rawEnv);
      if (canonicalSessionId === sessionId) {
        continue;
      }

      const result = migrateSqliteConversationSession(db, sessionId, canonicalSessionId);
      if (!result.migrated) {
        continue;
      }

      applied.push(
        `normalized conversation session ${sessionId} -> ${canonicalSessionId} (messages=${result.messagesMoved}, events=${result.eventsMoved})`,
      );
    }
  } catch (error) {
    skipped.push(
      `conversation session normalization skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    db.close();
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

function rebuildEmbeddingsIfSafe(
  snapshot: RuntimeHealthSnapshot,
  rawEnv: NodeJS.ProcessEnv,
  applied: string[],
  skipped: string[],
): void {
  if (!snapshot.embeddings.rustEnabled) {
    return;
  }

  if (snapshot.chainMemory.integrity.status === 'degraded') {
    skipped.push('embedding rebuild skipped: canonical chain integrity is degraded');
    return;
  }

  if (!snapshot.embeddings.bridgeLoaded || !snapshot.embeddings.embedApiAvailable) {
    skipped.push(snapshot.embeddings.recommendedAction);
    return;
  }

  try {
    const result = rebuildDerivedEmbeddings({}, rawEnv);
    applied.push(
      `rebuilt derived embeddings (${result.indexed} indexed, ${result.skipped} skipped, chains=${result.chains.join(', ') || 'none'})`,
    );
  } catch (error) {
    skipped.push(
      `embedding rebuild skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
    const cognitiveConfig = loadCognitiveConfig();
    const learner = new ModelC_PredictivePatterns(blocks, cognitiveConfig.modelC);
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

  if (options.dryRun) {
    // A dry run writes NOTHING -- not a directory, not an index, not a
    // block. It answers one question: what would the history rewrite
    // change? And it answers it without asking for a passphrase, because
    // it rewrites nothing.
    //
    // The "after" snapshot IS the "before" snapshot: nothing was written,
    // so there is nothing new to measure.
    const vocabularyScan = scanChainVocabulary(rawEnv, options.vocabulary);
    if (!vocabularyScan.oracleAvailable) {
      skipped.push(
        'the native core could not be loaded, so no block could be checked and no chain history was rewritten',
      );
    } else if (vocabularyScan.unreadable.length === 0) {
      applied.push(
        `chain vocabulary: every one of the ${vocabularyScan.blocksScanned} live blocks is in the core's vocabulary`,
      );
    } else {
      const preview = await repairChainVocabulary({
        rawEnv,
        scan: vocabularyScan,
        dryRun: true,
        vocabulary: options.vocabulary,
      });
      applied.push(...preview.applied);
      skipped.push(...preview.skipped);
      warnings.push(...preview.warnings);
    }
    applied.push('dry run: nothing was written');
    return {
      ok: before.repair.status !== 'degraded-manual',
      status: before.repair.status,
      repairable: before.repair.repairable,
      recommendedAction: before.repair.recommendedAction,
      applied,
      skipped,
      warnings,
      before,
      after: before,
    };
  }

  ensureRuntimeLayout(rawEnv, config, applied);
  removeStaleRuntimeArtifacts(rawEnv, applied);
  initializeSqlite(config, applied, skipped);
  normalizeConversationSessions(config, rawEnv, applied, skipped);
  normalizeLegacyRuntimeState(before, rawEnv, applied, warnings);

  // The vocabulary repair rewrites chain history, so it is gated on the
  // operator's consent. Ungated, the repair would rewrite the blocks the
  // native core cannot read — exactly the kind of "fix" that erases the
  // evidence of what went wrong.
  const vocabularyScan = scanChainVocabulary(rawEnv, options.vocabulary);
  if (!vocabularyScan.oracleAvailable) {
    skipped.push(
      'the native core could not be loaded, so no block could be checked and no chain history was rewritten',
    );
  } else if (vocabularyScan.unreadable.length === 0) {
    applied.push(
      `chain vocabulary: every one of the ${vocabularyScan.blocksScanned} live blocks is in the core's vocabulary`,
    );
  } else {
    const named = vocabularyScan.unreadable
      .map((entry) => `${entry.directory}/${entry.file}`)
      .join(', ');
    const authorized =
      options.authorizeHistoryRewrite === undefined
        ? false
        : await options.authorizeHistoryRewrite();
    if (!authorized) {
      skipped.push(
        `chain history was not rewritten: ${vocabularyScan.unreadable.length} block(s) cannot be read by the native core (${named}), and rewriting them needs the operator passphrase`,
      );
    } else {
      const vocabulary = await repairChainVocabulary({
        rawEnv,
        scan: vocabularyScan,
        vocabulary: options.vocabulary,
      });
      applied.push(...vocabulary.applied);
      skipped.push(...vocabulary.skipped);
      warnings.push(...vocabulary.warnings);
    }
  }

  if (before.repair.status !== 'degraded-manual' || options.force) {
    rebuildExactSearchIfSafe(before, rawEnv, applied, skipped);
    rebuildEmbeddingsIfSafe(before, rawEnv, applied, skipped);
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
