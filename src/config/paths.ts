import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MEMPHIS_DATA_DIR = '~/.memphis';
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
  const configured = rawEnv.MEMPHIS_DATA_DIR ?? rawEnv.MEMPHIS_DIR ?? DEFAULT_MEMPHIS_DATA_DIR;
  return path.resolve(expandHome(configured));
}

export function normalizeChainName(chainName?: string): string | undefined {
  if (chainName === undefined) return undefined;
  const trimmed = chainName.trim();
  if (!trimmed) return trimmed;
  return CHAIN_NAME_ALIASES[trimmed] ?? trimmed;
}

export function getReadableChainNames(chainName?: string): string[] {
  const normalized = normalizeChainName(chainName);
  if (!normalized) return [];

  const aliases = Object.entries(CHAIN_NAME_ALIASES)
    .filter(([, canonical]) => canonical === normalized)
    .map(([alias]) => alias);

  return Array.from(new Set([normalized, ...aliases]));
}

export function getReadableChainPaths(
  chainName: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const chainsDir = path.join(getDataDir(rawEnv), 'chains');
  return getReadableChainNames(chainName).map((name) => path.join(chainsDir, name));
}

export function getChainPath(chainName?: string, rawEnv: NodeJS.ProcessEnv = process.env): string {
  const chainsDir = path.join(getDataDir(rawEnv), 'chains');
  const normalized = normalizeChainName(chainName);
  return normalized ? path.join(chainsDir, normalized) : chainsDir;
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
