import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface EnvFileMutation {
  key: string;
  value: string;
}

export function findEnvFile(): string {
  const candidates = ['.env', '../.env', '../../.env'];
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (existsSync(absolute)) return absolute;
  }
  return resolve('.env');
}

function renderLine({ key, value }: EnvFileMutation): string {
  return `${key}=${value}`;
}

export function readEnvFile(envPath: string = findEnvFile()): string {
  if (!existsSync(envPath)) return '';
  return readFileSync(envPath, 'utf8');
}

export function upsertEnvVars(
  mutations: EnvFileMutation[],
  envPath: string = findEnvFile(),
): { path: string; written: EnvFileMutation[] } {
  const absolute = resolve(envPath);
  let content = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';

  for (const mutation of mutations) {
    const regex = new RegExp(`^${escapeForRegex(mutation.key)}=.*$`, 'm');
    const nextLine = renderLine(mutation);
    if (regex.test(content)) {
      content = content.replace(regex, nextLine);
    } else {
      content = (content.trimEnd().length > 0 ? `${content.trimEnd()}\n` : '') + `${nextLine}\n`;
    }
  }

  const tmpPath = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content, 'utf8');
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // chmod non-fatal on some platforms
  }
  renameSync(tmpPath, absolute);

  return { path: absolute, written: mutations };
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove env keys from .env (idempotent — keys already absent are no-ops).
 * Used by `vault entry-delete --force` and `vault sync-env` to drop
 * orphan `<PROVIDER>_VAULT_KEY` lines that point at vault entries which
 * no longer exist.
 */
export function removeEnvVars(
  keys: string[],
  envPath: string = findEnvFile(),
): { path: string; removed: string[] } {
  const absolute = resolve(envPath);
  if (!existsSync(absolute)) return { path: absolute, removed: [] };
  let content = readFileSync(absolute, 'utf8');
  const removed: string[] = [];

  for (const key of keys) {
    // Match `KEY=...` line plus its trailing newline so we don't leave
    // empty lines behind.
    const regex = new RegExp(`^${escapeForRegex(key)}=.*(\\r?\\n)?`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, '');
      removed.push(key);
    }
  }

  if (removed.length === 0) return { path: absolute, removed: [] };

  const tmpPath = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content, 'utf8');
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // chmod non-fatal on some platforms
  }
  renameSync(tmpPath, absolute);

  return { path: absolute, removed };
}

export interface EnvVaultKeyReference {
  envKey: string;
  envValue: string;
  style: 'vault-key' | 'vault-prefix';
}

export function findVaultKeyReferences(
  vaultKey: string,
  envPath: string = findEnvFile(),
): EnvVaultKeyReference[] {
  const content = readEnvFile(envPath);
  if (!content) return [];

  const refs: EnvVaultKeyReference[] = [];
  const lines = content.split(/\r?\n/);
  const vaultKeyEscaped = vaultKey.trim();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, envKey, rawValue] = match;
    const value = rawValue.trim().replace(/^["']|["']$/g, '');

    if (envKey.endsWith('_VAULT_KEY') && value === vaultKeyEscaped) {
      refs.push({ envKey, envValue: value, style: 'vault-key' });
      continue;
    }
    if (value === `VAULT:${vaultKeyEscaped}`) {
      refs.push({ envKey, envValue: value, style: 'vault-prefix' });
    }
  }

  return refs;
}
