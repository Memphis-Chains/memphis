import { resolve } from 'node:path';

import { getDataDir } from '../../config/paths.js';
import { resolveInstallRootWithSource } from '../runtime/install-root.js';
import { resolveVaultPath } from '../storage/vault-paths.js';

export type RuntimeConfigSource =
  | 'env-override'
  | 'binary-path'
  | 'cwd-fallback'
  | 'env-file'
  | 'runtime-root'
  | 'install-root'
  | 'env-path'
  | 'legacy-install-data'
  | 'data-dir-default';

export interface RuntimeConfigSnapshot {
  schemaVersion: 1;
  generation: number;
  runtimeRoot: { path: string; source: RuntimeConfigSource };
  dotenv: { path: string; source: RuntimeConfigSource };
  dataDir: { path: string; source: RuntimeConfigSource };
  vaultState: { path: string; source: RuntimeConfigSource };
  vaultEntries: { path: string; source: RuntimeConfigSource };
}

export interface RuntimeConfigSnapshotOptions {
  cwd?: string;
  rootHint?: { path: string; source: 'binary-path' | 'cwd-fallback' };
}

let lastFingerprint = '';
let currentGeneration = 0;
let activeSnapshot: RuntimeConfigSnapshot | undefined;

function pathSource(
  rawEnv: NodeJS.ProcessEnv,
  envKey: string,
  resolvedPath: string,
  defaultPath: string,
): RuntimeConfigSource {
  if (rawEnv[envKey]?.trim()) return 'env-path';
  return resolvedPath === defaultPath ? 'data-dir-default' : 'legacy-install-data';
}

/** Resolve path choices once and retain provenance without exposing config values. */
export function resolveRuntimeConfigSnapshot(
  rawEnv: NodeJS.ProcessEnv = process.env,
  options: RuntimeConfigSnapshotOptions = {},
): RuntimeConfigSnapshot {
  const rootOverride = rawEnv.MEMPHIS_RUNTIME_ROOT?.trim();
  const install =
    rootOverride || options.rootHint
      ? null
      : resolveInstallRootWithSource({ rawEnv, cwd: options.cwd });
  const rootPath = rootOverride
    ? resolve(rootOverride)
    : options.rootHint
      ? resolve(options.rootHint.path)
      : install!.root;
  const rootSource: RuntimeConfigSource = rootOverride
    ? 'env-override'
    : options.rootHint
      ? options.rootHint.source
      : install!.source;
  const explicitEnv = rawEnv.MEMPHIS_ENV_FILE?.trim();
  const dotenvPath = explicitEnv ? resolve(explicitEnv) : resolve(rootPath, '.env');
  const dotenvSource: RuntimeConfigSource = explicitEnv
    ? 'env-file'
    : rootOverride
      ? 'runtime-root'
      : options.rootHint
        ? 'runtime-root'
        : 'install-root';

  const dataDirPath = getDataDir(rawEnv);
  const vaultStatePath = resolveVaultPath('vault-state.json', rawEnv);
  const vaultEntriesPath = resolveVaultPath('vault-entries.json', rawEnv);
  const fingerprint = JSON.stringify([
    rootPath,
    rootSource,
    dotenvPath,
    dotenvSource,
    dataDirPath,
    vaultStatePath,
    vaultEntriesPath,
  ]);
  if (fingerprint !== lastFingerprint) {
    lastFingerprint = fingerprint;
    currentGeneration += 1;
  }

  return {
    schemaVersion: 1,
    generation: currentGeneration,
    runtimeRoot: { path: rootPath, source: rootSource },
    dotenv: { path: dotenvPath, source: dotenvSource },
    dataDir: {
      path: dataDirPath,
      source: rawEnv.MEMPHIS_DATA_DIR?.trim() ? 'env-path' : 'data-dir-default',
    },
    vaultState: {
      path: vaultStatePath,
      source: pathSource(
        rawEnv,
        'MEMPHIS_VAULT_STATE_PATH',
        vaultStatePath,
        resolve(dataDirPath, 'vault-state.json'),
      ),
    },
    vaultEntries: {
      path: vaultEntriesPath,
      source: pathSource(
        rawEnv,
        'MEMPHIS_VAULT_ENTRIES_PATH',
        vaultEntriesPath,
        resolve(dataDirPath, 'vault-entries.json'),
      ),
    },
  };
}

/** Native children receive the same resolved paths as the TypeScript host. */
export function nativeRuntimeEnvironment(
  snapshot: RuntimeConfigSnapshot,
  rawEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...rawEnv,
    MEMPHIS_RUNTIME_ROOT: snapshot.runtimeRoot.path,
    MEMPHIS_RUNTIME_ROOT_SOURCE: snapshot.runtimeRoot.source,
    MEMPHIS_ENV_FILE: snapshot.dotenv.path,
    MEMPHIS_ENV_FILE_SOURCE: snapshot.dotenv.source,
    MEMPHIS_DATA_DIR: snapshot.dataDir.path,
    MEMPHIS_VAULT_STATE_PATH: snapshot.vaultState.path,
    MEMPHIS_VAULT_ENTRIES_PATH: snapshot.vaultEntries.path,
    MEMPHIS_CONFIG_GENERATION: String(snapshot.generation),
  };
}

export function resetRuntimeConfigSnapshotForTests(): void {
  lastFingerprint = '';
  currentGeneration = 0;
  activeSnapshot = undefined;
}

/** Pin startup paths before creating services. Generation is process-local. */
export function initializeRuntimeConfigSnapshot(
  rawEnv: NodeJS.ProcessEnv = process.env,
): RuntimeConfigSnapshot {
  const snapshot = resolveRuntimeConfigSnapshot(rawEnv);
  for (const value of Object.values(snapshot)) {
    if (typeof value === 'object') Object.freeze(value);
  }
  activeSnapshot = Object.freeze(snapshot);
  const normalized = nativeRuntimeEnvironment(snapshot, rawEnv);
  for (const key of [
    'MEMPHIS_RUNTIME_ROOT',
    'MEMPHIS_RUNTIME_ROOT_SOURCE',
    'MEMPHIS_ENV_FILE',
    'MEMPHIS_ENV_FILE_SOURCE',
    'MEMPHIS_DATA_DIR',
    'MEMPHIS_VAULT_STATE_PATH',
    'MEMPHIS_VAULT_ENTRIES_PATH',
    'MEMPHIS_CONFIG_GENERATION',
  ])
    rawEnv[key] = normalized[key];
  return activeSnapshot;
}

export function getActiveRuntimeConfigSnapshot(): RuntimeConfigSnapshot | undefined {
  return activeSnapshot;
}

/** Publish only after an accepted env swap; rejected/no-op reloads do not advance. */
export function advanceRuntimeConfigGeneration(): void {
  if (!activeSnapshot) return;
  currentGeneration += 1;
  activeSnapshot = Object.freeze({ ...activeSnapshot, generation: currentGeneration });
  process.env.MEMPHIS_CONFIG_GENERATION = String(currentGeneration);
}
