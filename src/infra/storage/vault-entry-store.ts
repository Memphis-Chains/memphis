import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { vaultDecrypt, type VaultEntry } from './rust-vault-adapter.js';
import { healSensitiveFilePerms } from './secure-file.js';
import { resolveVaultPath } from './vault-paths.js';
import { secureCompare } from '../../security/constant-time.js';
import { withConfigurationWriteLock } from '../config/config-transaction.js';
import { writePrivateAtomicFile } from '../config/private-atomic-file.js';

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

function readAll(path: string, strict = false): StoredVaultEntry[] {
  if (!existsSync(path)) return [];
  // Heal-on-load: existing operator installs from before PR #275
  // started enforcing 0600 may still have group/world-readable
  // vault-entries.json on disk (664 was the umask default).
  // Tighten silently with a one-time warn so the next CLI invocation
  // already fixes it without operator intervention.
  healSensitiveFilePerms(path);
  try {
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) {
      if (strict) throw new Error('Empty vault entries');
      return [];
    }
    const parsed = JSON.parse(raw) as StoredVaultEntry[];
    if (!Array.isArray(parsed)) throw new Error('Invalid vault entries');
    if (
      strict &&
      parsed.some(
        (entry) =>
          !entry ||
          typeof entry.key !== 'string' ||
          typeof entry.encrypted !== 'string' ||
          typeof entry.iv !== 'string',
      )
    ) {
      throw new Error('Invalid vault entry record');
    }

    // migration-safe normalization: older records may miss fingerprint
    return parsed.map((item) => ({
      ...item,
      fingerprint:
        typeof item.fingerprint === 'string' && item.fingerprint.length > 0
          ? item.fingerprint
          : computeFingerprint(item),
    }));
  } catch {
    if (strict)
      throw new Error('Vault entries are unreadable; refusing to overwrite existing data');
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
  writePrivateAtomicFile(path, JSON.stringify(entries, null, 2));
}

function journalPath(rawEnv: NodeJS.ProcessEnv): string {
  return rawEnv.MEMPHIS_ENV_FILE || resolveVaultPath('vault-state.json', rawEnv);
}

export function saveVaultEntry(
  entry: VaultEntry,
  rawEnv: NodeJS.ProcessEnv = process.env,
): StoredVaultEntry {
  return withConfigurationWriteLock(journalPath(rawEnv), () => {
    const path = getStorePath(rawEnv);
    const all = readAll(path, true);
    // Encryption can precede a concurrent key rotation. Validate under the same
    // lock used for publication so stale ciphertext never enters the store.
    if (existsSync(resolveVaultPath('vault-state.json', rawEnv))) {
      try {
        vaultDecrypt(entry, rawEnv);
      } catch {
        throw new Error('Entry cannot be decrypted by the current vault; encrypt again and retry');
      }
    }

    const stored: StoredVaultEntry = {
      ...entry,
      createdAt: entry.createdAt ?? new Date().toISOString(),
      fingerprint: computeFingerprint(entry),
    };

    all.push(stored);
    writeAll(path, all);
    return stored;
  });
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
  return withConfigurationWriteLock(journalPath(rawEnv), () => {
    const path = getStorePath(rawEnv);
    const all = readAll(path, true);
    const kept = all.filter((entry) => entry.key !== key);
    const removedCount = all.length - kept.length;
    writeAll(path, kept);
    return { removedCount, remainingCount: kept.length, path };
  });
}
