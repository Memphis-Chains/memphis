import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { VaultEntry } from './rust-vault-adapter.js';

export interface StoredVaultEntry extends VaultEntry {
  createdAt: string;
  fingerprint: string;
}

function getStorePath(rawEnv: NodeJS.ProcessEnv): string {
  return rawEnv.MEMPHIS_VAULT_ENTRIES_PATH ?? './data/vault-entries.json';
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
  writeFileSync(path, JSON.stringify(entries, null, 2));
}

export function saveVaultEntry(entry: VaultEntry, rawEnv: NodeJS.ProcessEnv = process.env): StoredVaultEntry {
  const path = getStorePath(rawEnv);
  const all = readAll(path);

  const stored: StoredVaultEntry = {
    ...entry,
    createdAt: new Date().toISOString(),
    fingerprint: computeFingerprint(entry),
  };

  all.push(stored);
  writeAll(path, all);
  return stored;
}

export function listVaultEntries(rawEnv: NodeJS.ProcessEnv = process.env, key?: string): StoredVaultEntry[] {
  const path = getStorePath(rawEnv);
  const all = readAll(path);
  if (!key) return all;
  return all.filter((e) => e.key === key);
}

export function verifyVaultEntry(entry: StoredVaultEntry): boolean {
  const expected = computeFingerprint(entry);
  return expected === entry.fingerprint;
}
