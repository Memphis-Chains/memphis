import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';

import { getChainPath, getDataDir, getReadableChainPaths } from '../../config/paths.js';
import type { AppConfig } from '../config/schema.js';
import { getRustEmbedAdapterStatus } from '../storage/rust-embed-adapter.js';

const CANONICAL_CHAIN_NAMES = [
  'journal',
  'decisions',
  'reflections',
  'patterns',
  'cases',
  'system',
  'proactive',
] as const;

const SEARCHABLE_CHAIN_NAMES = ['journal', 'decisions', 'patterns', 'reflections', 'proactive'] as const;
const CANONICAL_MEMORY_CHAIN_NAMES = [
  'journal',
  'decisions',
  'reflections',
  'cases',
  'system',
  'proactive',
] as const;

export type OfflineRuntimeMode = 'local-fallback' | 'ollama-local' | 'remote';
export type ChainMemoryStatus = 'missing' | 'empty' | 'ready';
export type ExactSearchStatus = 'unavailable' | 'empty' | 'rebuildable' | 'indexed';
export type EmbeddingRuntimeStatus = 'disabled' | 'local' | 'active' | 'degraded';
export type RecallRuntimeMode = 'semantic' | 'exact' | 'chain' | 'none';
export type CognitivePersistenceStatus = 'ready' | 'degraded' | 'unavailable';
export type ChainIntegrityStatus = 'unavailable' | 'ready' | 'degraded';
export type RuntimeRepairStatus = 'healthy' | 'degraded-repairable' | 'degraded-manual';

export type RuntimeHealthSnapshot = {
  offline: {
    activeMode: OfflineRuntimeMode;
    defaultProvider: AppConfig['DEFAULT_PROVIDER'];
    localFallbackEnabled: boolean;
    ollamaUrl: string;
    ollamaReachable: boolean;
    supportedModes: Array<'local-fallback' | 'ollama-local'>;
    ready: boolean;
  };
  chainMemory: {
    status: ChainMemoryStatus;
    chainRoot: string;
    totalBlocks: number;
    cognitiveReady: boolean;
    counts: Record<string, number>;
    activeChains: string[];
    integrity: {
      status: ChainIntegrityStatus;
      checked: number;
      invalid: number;
      repairable: boolean;
      recommendedAction: string;
    };
  };
  exactSearch: {
    status: ExactSearchStatus;
    databasePath: string | null;
    entries: number;
    rebuildable: boolean;
    sourceChains: string[];
    repairable: boolean;
    recommendedAction: string;
  };
  embeddings: {
    mode: string;
    status: EmbeddingRuntimeStatus;
    rustEnabled: boolean;
    bridgeLoaded: boolean;
    embedApiAvailable: boolean;
    tunedSearchAvailable: boolean;
    repairable: boolean;
    recommendedAction: string;
  };
  memory: {
    recallMode: RecallRuntimeMode;
    degraded: boolean;
    recommendedAction: string;
  };
  cognition: {
    persistenceStatus: CognitivePersistenceStatus;
    patternsChain: {
      entries: number;
      checked: number;
      invalid: number;
    };
    repairable: boolean;
    recommendedAction: string;
  };
  repair: {
    status: RuntimeRepairStatus;
    repairable: boolean;
    recommendedAction: string;
    reasons: string[];
  };
};

function resolveSqlitePath(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith('file:')) return null;
  return resolve(databaseUrl.replace(/^file:/, ''));
}

function countBlocksInChain(chainName: string, rawEnv: NodeJS.ProcessEnv): number {
  let total = 0;

  for (const chainDir of getReadableChainPaths(chainName, rawEnv)) {
    if (!existsSync(chainDir)) continue;

    try {
      total += readdirSync(chainDir)
        .filter((entry) => /^\d+\.json$/.test(entry))
        .filter((entry) => {
          try {
            return statSync(resolve(chainDir, entry)).isFile();
          } catch {
            return false;
          }
        }).length;
    } catch {
      // ignore per-path read errors and keep scanning readable aliases
    }
  }

  return total;
}

function inspectChainIntegrity(
  chainName: string,
  rawEnv: NodeJS.ProcessEnv,
): { checked: number; invalid: number } {
  let checked = 0;
  let invalid = 0;

  for (const chainDir of getReadableChainPaths(chainName, rawEnv)) {
    if (!existsSync(chainDir)) continue;

    let previousHash = '';
    try {
      const files = readdirSync(chainDir)
        .filter((entry) => /^\d+\.json$/.test(entry))
        .sort((left, right) => left.localeCompare(right));
      for (const file of files) {
        checked += 1;
        try {
          const payload = JSON.parse(readFileSync(resolve(chainDir, file), 'utf8')) as {
            hash?: string;
            prev_hash?: string;
          };
          const hashOk = typeof payload.hash === 'string' && /^[a-f0-9]{64}$/i.test(payload.hash);
          const prevOk =
            previousHash === ''
              ? typeof payload.prev_hash === 'string'
              : payload.prev_hash === previousHash;
          if (!hashOk || !prevOk) {
            invalid += 1;
          }
          previousHash = typeof payload.hash === 'string' ? payload.hash : '';
        } catch {
          invalid += 1;
        }
      }
    } catch {
      // ignore unreadable aliases and keep scanning
    }
  }

  return { checked, invalid };
}

function inspectChainsIntegrity(
  chainNames: readonly string[],
  rawEnv: NodeJS.ProcessEnv,
): { checked: number; invalid: number } {
  return chainNames.reduce(
    (acc, chainName) => {
      const current = inspectChainIntegrity(chainName, rawEnv);
      acc.checked += current.checked;
      acc.invalid += current.invalid;
      return acc;
    },
    { checked: 0, invalid: 0 },
  );
}

function resolveChainIntegrityStatus(
  chainMemoryStatus: ChainMemoryStatus,
  integrity: { checked: number; invalid: number },
): RuntimeHealthSnapshot['chainMemory']['integrity'] {
  if (chainMemoryStatus === 'missing') {
    return {
      status: 'unavailable',
      checked: integrity.checked,
      invalid: integrity.invalid,
      repairable: false,
      recommendedAction: 'Persist canonical chain history before relying on local memory repair',
    };
  }

  if (integrity.invalid > 0) {
    return {
      status: 'degraded',
      checked: integrity.checked,
      invalid: integrity.invalid,
      repairable: false,
      recommendedAction:
        'Canonical chain integrity is degraded; restore from backup or run memphis reset --runtime --yes if you intend a clean baseline',
    };
  }

  return {
    status: 'ready',
    checked: integrity.checked,
    invalid: integrity.invalid,
    repairable: false,
    recommendedAction: 'none',
  };
}

function collectChainMemorySnapshot(
  rawEnv: NodeJS.ProcessEnv,
): RuntimeHealthSnapshot['chainMemory'] {
  const chainRoot = getChainPath(undefined, rawEnv);
  if (!existsSync(chainRoot)) {
    return {
      status: 'missing',
      chainRoot,
      totalBlocks: 0,
      cognitiveReady: false,
      counts: {},
      activeChains: [],
      integrity: {
        status: 'unavailable',
        checked: 0,
        invalid: 0,
        repairable: false,
        recommendedAction: 'Persist canonical chain history before relying on local memory repair',
      },
    };
  }

  const counts = Object.fromEntries(
    CANONICAL_CHAIN_NAMES.map((chain) => [chain, countBlocksInChain(chain, rawEnv)]),
  );
  const totalBlocks = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const activeChains = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([chain]) => chain)
    .sort((left, right) => left.localeCompare(right));
  const cognitiveReady = counts.journal > 0 || counts.decisions > 0 || counts.reflections > 0;
  const status = totalBlocks > 0 ? 'ready' : 'empty';
  const integrity = resolveChainIntegrityStatus(
    status,
    inspectChainsIntegrity(CANONICAL_MEMORY_CHAIN_NAMES, rawEnv),
  );

  return {
    status,
    chainRoot,
    totalBlocks,
    cognitiveReady,
    counts,
    activeChains,
    integrity,
  };
}

function countExactSearchEntries(databasePath: string): number {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_search_entries' LIMIT 1",
      )
      .get() as { name?: string } | undefined;
    if (!table?.name) {
      return 0;
    }

    const row = db.prepare('SELECT COUNT(*) AS count FROM memory_search_entries').get() as {
      count: number;
    };
    return row.count;
  } finally {
    db.close();
  }
}

function collectExactSearchSnapshot(
  databaseUrl: string,
  chainMemory: RuntimeHealthSnapshot['chainMemory'],
): RuntimeHealthSnapshot['exactSearch'] {
  const databasePath = resolveSqlitePath(databaseUrl);
  const sourceChains = SEARCHABLE_CHAIN_NAMES.filter((chain) => (chainMemory.counts[chain] ?? 0) > 0);
  const rebuildable = sourceChains.length > 0;
  const repairable =
    chainMemory.integrity.status !== 'degraded' && databasePath !== null;
  const recommendedAction =
    chainMemory.integrity.status === 'degraded'
      ? 'Repair canonical chain integrity before rebuilding derived exact-search state'
      : databasePath === null
        ? 'Set DATABASE_URL to a file: SQLite path to enable exact-search repair'
        : rebuildable
          ? 'Run memphis repair runtime or memphis search rebuild --json to repopulate exact-search from chain truth'
          : 'Run memphis repair runtime to initialize the local SQLite exact-search state';

  if (!databasePath || !existsSync(databasePath)) {
    return {
      status: 'unavailable',
      databasePath,
      entries: 0,
      rebuildable,
      sourceChains,
      repairable,
      recommendedAction,
    };
  }

  try {
    const entries = countExactSearchEntries(databasePath);
    return {
      status: entries > 0 ? 'indexed' : rebuildable ? 'rebuildable' : 'empty',
      databasePath,
      entries,
      rebuildable,
      sourceChains,
      repairable,
      recommendedAction: entries > 0 ? 'none' : recommendedAction,
    };
  } catch {
    return {
      status: 'unavailable',
      databasePath,
      entries: 0,
      rebuildable,
      sourceChains,
      repairable,
      recommendedAction,
    };
  }
}

async function pingOllama(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(400),
    });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

function resolveOfflineMode(
  config: Pick<AppConfig, 'DEFAULT_PROVIDER' | 'LOCAL_FALLBACK_ENABLED'>,
): OfflineRuntimeMode {
  if (config.DEFAULT_PROVIDER === 'local-fallback') return 'local-fallback';
  if (config.DEFAULT_PROVIDER === 'ollama') return 'ollama-local';
  return 'remote';
}

function collectEmbeddingSnapshot(
  rawEnv: NodeJS.ProcessEnv,
): RuntimeHealthSnapshot['embeddings'] {
  const adapter = getRustEmbedAdapterStatus(rawEnv);
  const mode = rawEnv.RUST_EMBED_MODE ?? 'local';

  let status: EmbeddingRuntimeStatus;
  if (!adapter.rustEnabled) status = 'disabled';
  else if (mode === 'local' && adapter.bridgeLoaded && adapter.embedApiAvailable) status = 'local';
  else if (adapter.bridgeLoaded && adapter.embedApiAvailable) status = 'active';
  else status = 'degraded';

  return {
    mode,
    status,
    rustEnabled: adapter.rustEnabled,
    bridgeLoaded: adapter.bridgeLoaded,
    embedApiAvailable: adapter.embedApiAvailable,
    tunedSearchAvailable: adapter.tunedSearchAvailable,
    repairable: false,
    recommendedAction:
      status === 'degraded'
        ? 'Restore the Rust embed bridge or run memphis embed reindex once embeddings are healthy again'
        : 'none',
  };
}

function resolveRecallMode(
  chainMemory: RuntimeHealthSnapshot['chainMemory'],
  exactSearch: RuntimeHealthSnapshot['exactSearch'],
  embeddings: RuntimeHealthSnapshot['embeddings'],
): RuntimeHealthSnapshot['memory'] {
  if (
    (embeddings.status === 'local' || embeddings.status === 'active') &&
    chainMemory.status === 'ready'
  ) {
    return { recallMode: 'semantic', degraded: false, recommendedAction: 'none' };
  }

  if (exactSearch.status !== 'unavailable' && (exactSearch.entries > 0 || exactSearch.rebuildable)) {
    return {
      recallMode: 'exact',
      degraded: embeddings.status === 'degraded',
      recommendedAction:
        embeddings.status === 'degraded'
          ? 'Embeddings are degraded; exact-search is active as the bounded local fallback'
          : exactSearch.status === 'rebuildable'
            ? 'Run memphis repair runtime to warm the derived exact-search index from chain truth'
            : 'none',
    };
  }

  if (chainMemory.status === 'ready') {
    return {
      recallMode: 'chain',
      degraded: embeddings.status === 'degraded' || exactSearch.status === 'unavailable',
      recommendedAction:
        chainMemory.integrity.status === 'degraded'
          ? chainMemory.integrity.recommendedAction
          : 'Run memphis repair runtime to restore derived recall indexes, or keep chain-only recall as the bounded fallback',
    };
  }

  return {
    recallMode: 'none',
    degraded: embeddings.status === 'degraded' || exactSearch.status === 'unavailable',
    recommendedAction:
      exactSearch.status === 'unavailable' && exactSearch.repairable
        ? 'Run memphis repair runtime to initialize local exact-search state'
        : 'Persist chain history to enable local recall',
  };
}

function collectCognitiveSnapshot(
  chainMemory: RuntimeHealthSnapshot['chainMemory'],
  rawEnv: NodeJS.ProcessEnv,
): RuntimeHealthSnapshot['cognition'] {
  const hasPatternSourceHistory =
    (chainMemory.counts.decisions ?? 0) + (chainMemory.counts.journal ?? 0) >= 3;

  if (chainMemory.status === 'missing') {
    return {
      persistenceStatus: 'unavailable',
      patternsChain: { entries: 0, checked: 0, invalid: 0 },
      repairable: false,
      recommendedAction: 'Persist canonical chain history before relying on cognitive persistence',
    };
  }

  const patternsChain = inspectChainIntegrity('patterns', rawEnv);
  const entries = countBlocksInChain('patterns', rawEnv);
  const degraded =
    patternsChain.invalid > 0 || (hasPatternSourceHistory && entries === 0);
  const repairable = degraded && chainMemory.integrity.status !== 'degraded';
  const persistenceStatus =
    !hasPatternSourceHistory && entries === 0
      ? 'unavailable'
      : degraded
        ? 'degraded'
        : 'ready';

  return {
    persistenceStatus,
    patternsChain: {
      entries,
      checked: patternsChain.checked,
      invalid: patternsChain.invalid,
    },
    repairable,
    recommendedAction: persistenceStatus === 'degraded'
      ? repairable
        ? 'Run memphis repair runtime to rebuild the derived patterns chain from canonical history'
        : 'Repair canonical chain integrity before rebuilding derived cognitive pattern state'
      : persistenceStatus === 'unavailable'
        ? 'Persist canonical cognitive history before relying on predictive patterns'
      : 'none',
  };
}

function collectRepairSnapshot(
  chainMemory: RuntimeHealthSnapshot['chainMemory'],
  exactSearch: RuntimeHealthSnapshot['exactSearch'],
  embeddings: RuntimeHealthSnapshot['embeddings'],
  cognition: RuntimeHealthSnapshot['cognition'],
): RuntimeHealthSnapshot['repair'] {
  const reasons: string[] = [];

  if (chainMemory.integrity.status === 'degraded') {
    reasons.push('canonical chain integrity degraded');
    return {
      status: 'degraded-manual',
      repairable: false,
      recommendedAction: chainMemory.integrity.recommendedAction,
      reasons,
    };
  }

  if (exactSearch.status === 'unavailable' || exactSearch.status === 'rebuildable') {
    reasons.push('exact-search derived state needs repair');
  }
  if (cognition.persistenceStatus === 'degraded') {
    reasons.push('cognitive pattern state degraded');
  }
  if (embeddings.status === 'degraded') {
    reasons.push('embeddings degraded');
  }

  if (exactSearch.repairable && (exactSearch.status === 'unavailable' || exactSearch.status === 'rebuildable')) {
    return {
      status: 'degraded-repairable',
      repairable: true,
      recommendedAction: 'Run memphis repair runtime',
      reasons,
    };
  }

  if (cognition.repairable) {
    return {
      status: 'degraded-repairable',
      repairable: true,
      recommendedAction: 'Run memphis repair runtime',
      reasons,
    };
  }

  if (embeddings.status === 'degraded') {
    return {
      status: 'degraded-manual',
      repairable: false,
      recommendedAction: embeddings.recommendedAction,
      reasons,
    };
  }

  return {
    status: 'healthy',
    repairable: false,
    recommendedAction: 'none',
    reasons,
  };
}

export async function buildRuntimeHealthSnapshot(
  config: Pick<AppConfig, 'DATABASE_URL' | 'DEFAULT_PROVIDER' | 'LOCAL_FALLBACK_ENABLED'>,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeHealthSnapshot> {
  const offlineMode = resolveOfflineMode(config);
  const ollamaUrl = rawEnv.OLLAMA_URL?.trim() || 'http://127.0.0.1:11434';
  const ollamaReachable = await pingOllama(ollamaUrl);
  const supportedModes: Array<'local-fallback' | 'ollama-local'> = [];

  if (config.LOCAL_FALLBACK_ENABLED) {
    supportedModes.push('local-fallback');
  }
  if (ollamaReachable) {
    supportedModes.push('ollama-local');
  }

  const chainMemory = collectChainMemorySnapshot(rawEnv);
  const exactSearch = collectExactSearchSnapshot(config.DATABASE_URL, chainMemory);
  const embeddings = collectEmbeddingSnapshot(rawEnv);
  const memory = resolveRecallMode(chainMemory, exactSearch, embeddings);
  const cognition = collectCognitiveSnapshot(chainMemory, rawEnv);
  const repair = collectRepairSnapshot(chainMemory, exactSearch, embeddings, cognition);

  return {
    offline: {
      activeMode: offlineMode,
      defaultProvider: config.DEFAULT_PROVIDER,
      localFallbackEnabled: config.LOCAL_FALLBACK_ENABLED,
      ollamaUrl,
      ollamaReachable,
      supportedModes,
      ready:
        offlineMode === 'local-fallback'
          ? config.LOCAL_FALLBACK_ENABLED
          : offlineMode === 'ollama-local'
            ? ollamaReachable
            : config.LOCAL_FALLBACK_ENABLED || ollamaReachable,
    },
    chainMemory,
    exactSearch,
    embeddings,
    memory,
    cognition,
    repair,
  };
}

export function getRuntimeHealthDataDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return resolve(getDataDir(rawEnv));
}
