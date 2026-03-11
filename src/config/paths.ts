import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MEMPHIS_DATA_DIR = '~/.memphis';

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

export function getChainPath(chainName?: string, rawEnv: NodeJS.ProcessEnv = process.env): string {
  const chainsDir = path.join(getDataDir(rawEnv), 'chains');
  return chainName ? path.join(chainsDir, chainName) : chainsDir;
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

export function getLogsPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDataDir(rawEnv), 'logs');
}

export function getConfigPath(...segments: string[]): string {
  return path.join(getDataDir(), 'config', ...segments);
}

export function ensureDir(dirPath: string): string {
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}
