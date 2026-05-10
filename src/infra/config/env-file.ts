import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveInstallRoot } from '../runtime/install-root.js';

export interface EnvFileMutation {
  key: string;
  value: string;
}

/**
 * Resolve the path to the canonical Memphis `.env` file.
 *
 * Anchored on the install root (via `resolveInstallRoot()` — checks
 * `MEMPHIS_RUNTIME_ROOT` env, `import.meta.url`, cwd, then
 * `realpath(argv[1])`), NOT on `process.cwd()`. This closes a bug
 * family that surfaced in the 2026-05-10 vault pepper rotation:
 *
 *   * `memphis vault pepper-rotate` from `$HOME` wrote the new pepper
 *     to `$HOME/.env` while the daemon (systemd unit
 *     `EnvironmentFile=/home/memphis/memphis/.env`) kept reading the
 *     OLD pepper. Vault unwrap failed across the runtime — every
 *     `VAULT:*` lookup returned "Vault entry decryption failed" until
 *     the operator manually copied the new pepper into the project
 *     `.env`.
 *   * `memphis auth provider <X>` from `$HOME` produced the same
 *     symptom for `ANTHROPIC_VAULT_KEY` / `MINIMAX_VAULT_KEY` /
 *     `BRAVE_SEARCH_VAULT_KEY`: keys landed in `$HOME/.env`, the
 *     daemon never saw them, `DEFAULT_PROVIDER=anthropic` cascaded
 *     down to ollama silently.
 *   * `memphis doctor` had the same shape (false-positive warns when
 *     run from `$HOME`); fixed in
 *     `fix/doctor-project-root-resolve` for that file specifically.
 *
 * `findEnvFile()` is the single shared entry point for env-file
 * writers (`upsertEnvVars`, `removeEnvVars`, `findVaultKeyReferences`),
 * so anchoring it correctly closes the whole family at once.
 *
 * If the install-root `.env` doesn't exist, we still return its path
 * (NOT cwd) so `upsertEnvVars` creates it in the right place.
 */
export function findEnvFile(): string {
  return resolve(resolveInstallRoot(), '.env');
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
