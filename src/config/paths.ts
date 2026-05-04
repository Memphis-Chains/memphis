import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bridgeNormalizeChainName,
  bridgeResolveChainPath,
  bridgeResolveChainsDir,
  bridgeResolveDataDir,
} from '../infra/storage/rust-paths-bridge.js';

/**
 * Sprint B note (2026-05-04): `getDataDir`, `getChainPath`, and
 * `normalizeChainName` are bridge-only — they call into
 * `crates/memphis-paths` via NAPI. The previous TS implementation
 * silently divergence-bugged when only one of TS/Rust got an env
 * override (the "TS sees `~/.memphis`, Rust sees `./data/`" class
 * documented in operator-incident 2026-04-29). Falling back to a
 * second TS path resolver was exactly the silent-split mode we
 * eliminated, so the bridge surfaces a loud error when unavailable.
 *
 * `expandHome` and the alias map remain on the TS side because the
 * helpers below (`getEmbeddingPath`, `getVaultPath`, `getSkillsPath`,
 * etc.) compose data_dir + a fixed segment without needing the bridge.
 * The bridge owns the data_dir computation; everything below joins
 * onto its result, so the agreement is preserved.
 */

const CHAIN_NAME_ALIASES: Record<string, string> = {
  case: 'cases',
  decision: 'decisions',
  pattern: 'patterns',
  reflection: 'reflections',
};

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function getDataDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return bridgeResolveDataDir(rawEnv);
}

export function normalizeChainName(chainName?: string): string | undefined {
  if (chainName === undefined) return undefined;
  const trimmed = chainName.trim();
  if (!trimmed) return trimmed;
  return bridgeNormalizeChainName(trimmed);
}

export function getReadableChainNames(chainName?: string): string[] {
  const normalized = normalizeChainName(chainName);
  if (!normalized) return [];

  // Aliases are mirrored in the Rust crate (`CHAIN_NAME_ALIASES`); the
  // table is kept in sync there. We compute readable names locally
  // because they're a derived set, not a path resolution — the bridge
  // owns paths, this owns the alias surface.
  const aliases = Object.entries(CHAIN_NAME_ALIASES)
    .filter(([, canonical]) => canonical === normalized)
    .map(([alias]) => alias);

  return Array.from(new Set([normalized, ...aliases]));
}

export function getReadableChainPaths(
  chainName: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const chainsDir = bridgeResolveChainsDir(rawEnv);
  return getReadableChainNames(chainName).map((name) => path.join(chainsDir, name));
}

export function getChainPath(chainName?: string, rawEnv: NodeJS.ProcessEnv = process.env): string {
  if (chainName === undefined || chainName.trim().length === 0) {
    return bridgeResolveChainsDir(rawEnv);
  }
  return bridgeResolveChainPath(chainName, rawEnv);
}

export function getEmbeddingPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDataDir(rawEnv), 'embeddings');
}

export function getVaultPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDataDir(rawEnv), 'vault');
}

export function getCachePath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDataDir(rawEnv), 'cache');
}

export function getBackupPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDataDir(rawEnv), 'backups');
}

export function getChainSnapshotsPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDataDir(rawEnv), 'chain-snapshots');
}

export function getLogsPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDataDir(rawEnv), 'logs');
}

export function getConfigPath(...segments: string[]): string {
  return path.join(getDataDir(), 'config', ...segments);
}

export function getAppsPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDataDir(rawEnv), 'apps');
}

export function getSkillsPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const configured = rawEnv.MEMPHIS_SKILLS_DIR;
  return configured
    ? path.resolve(expandHome(configured))
    : path.join(getDataDir(rawEnv), 'skills');
}

export function ensureDir(dirPath: string): string {
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

let _cachedVersion: string | undefined;

export function getAppVersion(): string {
  if (_cachedVersion) return _cachedVersion;
  if (process.env.npm_package_version) {
    _cachedVersion = process.env.npm_package_version;
    return _cachedVersion;
  }
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const root = path.resolve(path.dirname(thisFile), '..', '..');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    _cachedVersion = pkg.version;
  } catch {
    _cachedVersion = '0.0.0';
  }
  return _cachedVersion;
}
