import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { VaultEntry } from './rust-vault-adapter.js';
import { healSensitiveFilePerms } from './secure-file.js';
import { resolveVaultPath } from './vault-paths.js';
import { secureCompare } from '../../security/constant-time.js';

export interface StoredVaultEntry extends VaultEntry {
  createdAt: string;
  fingerprint: string;
}

function getStorePath(rawEnv: NodeJS.ProcessEnv): string {
  return resolveVaultPath('vault-entries.json', rawEnv);
}

function computeFingerprint(entry: Pick<VaultEntry, 'key' | 'encrypted' | 'iv'>): string {
  const payload = JSON.stringify({ key: entry.key, encrypted: entry.encrypted, iv: entry.iv });
  return createHash('sha256').update(payload).digest('hex');
}

function readAll(path: string): StoredVaultEntry[] {
  if (!existsSync(path)) return [];
  // Heal-on-load: existing operator installs from before PR #275
  // started enforcing 0600 may still have group/world-readable
  // vault-entries.json on disk (664 was the umask default).
  // Tighten silently with a one-time warn so the next CLI invocation
  // already fixes it without operator intervention.
  healSensitiveFilePerms(path);
  try {
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw) as StoredVaultEntry[];
    if (!Array.isArray(parsed)) return [];

    // migration-safe normalization: older records may miss fingerprint
    return parsed.map((item) => ({
      ...item,
      fingerprint:
        typeof item.fingerprint === 'string' && item.fingerprint.length > 0
          ? item.fingerprint
          : computeFingerprint(item),
    }));
  } catch {
    return [];
  }
}

function writeAll(path: string, entries: StoredVaultEntry[]): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // Sprint 2.2 (#275): enforce 0600 on vault entry metadata. Even though
  // ciphertext lives in vault.bin, the LIST of secret keys (entry names,
  // types, ages, tags) carries operationally significant info on its own
  // — `stripe_live`, `anthropic_prod`, `telegram_bot_token` reveal
  // integrations to any local user reading the file. POSIX 0600 closes
  // that read by anyone but the runtime user; on Windows the mode arg
  // is ignored which is fine (NTFS ACLs don't honor POSIX modes).
  writeFileSync(path, JSON.stringify(entries, null, 2), { mode: 0o600 });
  // Tighten existing files in case they were created before this fix
  // (or restored from a backup with permissive perms).
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort — Windows / non-POSIX filesystems may reject; don't
    // fail the write because chmod is unavailable.
  }
}

export function saveVaultEntry(
  entry: VaultEntry,
  rawEnv: NodeJS.ProcessEnv = process.env,
): StoredVaultEntry {
  const path = getStorePath(rawEnv);
  const all = readAll(path);

  const stored: StoredVaultEntry = {
    ...entry,
    createdAt: entry.createdAt ?? new Date().toISOString(),
    fingerprint: computeFingerprint(entry),
  };

  all.push(stored);
  writeAll(path, all);
  return stored;
}

export function listVaultEntries(
  rawEnv: NodeJS.ProcessEnv = process.env,
  key?: string,
): StoredVaultEntry[] {
  const path = getStorePath(rawEnv);
  const all = readAll(path);
  if (!key) return all;
  return all.filter((e) => e.key === key);
}

export function getLatestVaultEntry(
  key: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): StoredVaultEntry | undefined {
  const entries = listVaultEntries(rawEnv, key);
  return entries.at(-1);
}

export function verifyVaultEntry(entry: StoredVaultEntry): boolean {
  const expected = computeFingerprint(entry);
  return secureCompare(expected, entry.fingerprint);
}

export function deleteVaultEntriesByKey(
  key: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): { removedCount: number; remainingCount: number; path: string } {
  const path = getStorePath(rawEnv);
  const all = readAll(path);
  const kept = all.filter((entry) => entry.key !== key);
  const removedCount = all.length - kept.length;
  writeAll(path, kept);
  return { removedCount, remainingCount: kept.length, path };
}
