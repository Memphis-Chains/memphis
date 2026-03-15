import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ManagedAppExecutionResult,
  ManagedAppManifestRef,
  ManagedAppResolvedPaths,
} from './manifest.js';
import { getAppsPath } from '../../config/paths.js';

export type ManagedAppInstallState = 'planned' | 'installed' | 'stopped' | 'running' | 'unknown';

export type ManagedAppRegistryRecord = {
  id: string;
  name: string;
  source: { kind: 'builtin' | 'file'; path?: string };
  homepage?: string;
  paths: ManagedAppResolvedPaths;
  installed: boolean;
  state: ManagedAppInstallState;
  installedAt?: string;
  updatedAt: string;
  lastAction: string;
  lastActionAt: string;
  lastActionOk: boolean;
};

type ManagedAppRegistry = {
  schemaVersion: 1;
  apps: ManagedAppRegistryRecord[];
};

const DEFAULT_REGISTRY: ManagedAppRegistry = {
  schemaVersion: 1,
  apps: [],
};

function registryPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return join(getAppsPath(rawEnv), 'registry.json');
}

export function loadManagedAppRegistry(
  rawEnv: NodeJS.ProcessEnv = process.env,
): ManagedAppRegistry {
  const path = registryPath(rawEnv);
  if (!existsSync(path)) return { ...DEFAULT_REGISTRY, apps: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ManagedAppRegistry>;
    return {
      schemaVersion: 1,
      apps: Array.isArray(parsed.apps) ? (parsed.apps as ManagedAppRegistryRecord[]) : [],
    };
  } catch {
    return { ...DEFAULT_REGISTRY, apps: [] };
  }
}

export function saveManagedAppRegistry(
  registry: ManagedAppRegistry,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  const path = registryPath(rawEnv);
  mkdirSync(getAppsPath(rawEnv), { recursive: true });
  writeFileSync(path, JSON.stringify(registry, null, 2), 'utf8');
}

export function getManagedAppRegistryRecord(
  id: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): ManagedAppRegistryRecord | undefined {
  return loadManagedAppRegistry(rawEnv).apps.find((app) => app.id === id);
}

function nextStateForAction(
  action: string,
  previous?: ManagedAppRegistryRecord,
): ManagedAppInstallState {
  switch (action) {
    case 'install':
      return 'installed';
    case 'start':
    case 'restart':
      return 'running';
    case 'stop':
      return 'stopped';
    default:
      return previous?.state ?? (previous?.installed ? 'installed' : 'unknown');
  }
}

export function recordManagedAppExecution(
  ref: ManagedAppManifestRef,
  result: ManagedAppExecutionResult,
  rawEnv: NodeJS.ProcessEnv = process.env,
): ManagedAppRegistryRecord {
  const registry = loadManagedAppRegistry(rawEnv);
  const now = new Date().toISOString();
  const existing = registry.apps.find((app) => app.id === ref.manifest.id);
  const installed = existing?.installed === true || result.executed;

  const record: ManagedAppRegistryRecord = {
    id: ref.manifest.id,
    name: ref.manifest.name,
    source: ref.source,
    homepage: ref.manifest.homepage,
    paths: result.paths,
    installed,
    state: nextStateForAction(result.action, existing),
    installedAt: existing?.installedAt ?? (result.action === 'install' ? now : undefined),
    updatedAt: now,
    lastAction: result.action,
    lastActionAt: now,
    lastActionOk: true,
  };

  registry.apps = [record, ...registry.apps.filter((app) => app.id !== record.id)].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
  saveManagedAppRegistry(registry, rawEnv);
  return record;
}
