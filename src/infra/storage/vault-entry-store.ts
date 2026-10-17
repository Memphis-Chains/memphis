import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  parseVaultEntries,
  VaultEntryError,
  vaultDecrypt,
  type VaultEntry,
} from './rust-vault-adapter.js';
import { healSensitiveFilePerms } from './secure-file.js';
import { resolveVaultJournals, resolveVaultPath } from './vault-paths.js';
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

function readAll(
  path: string,
  rawEnv: NodeJS.ProcessEnv,
  key?: string,
  latest = false,
): StoredVaultEntry[] {
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new VaultEntryError('VAULT_ENTRIES_UNREADABLE');
  }
  healSensitiveFilePerms(path);
  return parseVaultEntries(raw, rawEnv, key, latest);
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

export function saveVaultEntry(
  entry: VaultEntry,
  rawEnv: NodeJS.ProcessEnv = process.env,
): StoredVaultEntry {
  return withConfigurationWriteLock(resolveVaultJournals(rawEnv).paths, () => {
    const path = getStorePath(rawEnv);
    const all = readAll(path, rawEnv);
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
  return readAll(path, rawEnv, key || undefined);
}

export function getLatestVaultEntry(
  key: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): StoredVaultEntry | undefined {
  return readAll(getStorePath(rawEnv), rawEnv, key, true)[0];
}

export function verifyVaultEntry(entry: StoredVaultEntry): boolean {
  const expected = computeFingerprint(entry);
  return secureCompare(expected, entry.fingerprint);
}

export function deleteVaultEntriesByKey(
  key: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): { removedCount: number; remainingCount: number; path: string } {
  return withConfigurationWriteLock(resolveVaultJournals(rawEnv).paths, () => {
    const path = getStorePath(rawEnv);
    const all = readAll(path, rawEnv);
    const kept = all.filter((entry) => entry.key !== key);
    const removedCount = all.length - kept.length;
    writeAll(path, kept);
    return { removedCount, remainingCount: kept.length, path };
  });
}
