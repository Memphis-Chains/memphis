import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { VaultEntry } from './rust-vault-adapter.js';
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
  // Pre-create at 0600 so the file is never readable by other local users
  // even for the milliseconds between create and chmod. writeFileSync's
  // mode option only applies on creation; pass it explicitly so a fresh
  // vault file lands at 0600 from the first byte.
  writeFileSync(path, JSON.stringify(entries, null, 2), { mode: 0o600 });
  // Defensive chmod for the case where the file already existed with
  // a different mode (writeFileSync with mode= ignores it on overwrite).
  // Issue #275: vault-entries.json was readable to other users on shared
  // hosts because writeFileSync uses the umask default (typically 0022 →
  // file ends at 0644). Operator's vault contents are AES-256-GCM
  // encrypted but the metadata (entry keys, fingerprints, IVs, audit
  // timestamps) leaks if anyone can read the file.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort — older Node on some platforms (Windows) may not
    // support chmod. Vault encryption still protects the contents.
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
