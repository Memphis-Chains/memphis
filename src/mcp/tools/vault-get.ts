import { isSessionAuthorized } from '../../infra/auth/operator-gate.js';
import { vaultDecrypt } from '../../infra/storage/rust-vault-adapter.js';
import { getLatestVaultEntry, listVaultEntries } from '../../infra/storage/vault-entry-store.js';

export interface VaultGetInput {
  key: string;
}

export interface VaultGetOutput {
  found: boolean;
  key: string;
  plaintext?: string;
  createdAt?: string;
  error?: string;
}

export interface VaultListOutput {
  count: number;
  keys: Array<{ key: string; createdAt: string }>;
  error?: string;
}

/**
 * Retrieve and decrypt a vault secret by key name.
 * Requires Rust bridge — returns a clear error if unavailable.
 * Requires operator authentication (session must be authorized).
 */
export function runMemphisVaultGet(input: VaultGetInput): VaultGetOutput {
  if (!isSessionAuthorized()) {
    return { found: false, key: input.key, error: 'Operator authentication required. Run: memphis operator login' };
  }
  const entry = getLatestVaultEntry(input.key);
  if (!entry) {
    return { found: false, key: input.key };
  }

  try {
    const plaintext = vaultDecrypt(entry);
    return { found: true, key: input.key, plaintext, createdAt: entry.createdAt };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { found: true, key: input.key, error: `Decryption failed: ${msg}` };
  }
}

/**
 * List vault entry keys (metadata only, no decryption).
 * Requires operator authentication (session must be authorized).
 */
export function runMemphisVaultList(): VaultListOutput {
  if (!isSessionAuthorized()) {
    return { count: 0, keys: [], error: 'Operator authentication required. Run: memphis operator login' };
  }
  const entries = listVaultEntries();
  const seen = new Map<string, string>();
  for (const e of entries) {
    // Keep latest createdAt per key
    seen.set(e.key, e.createdAt);
  }
  const keys = [...seen.entries()].map(([key, createdAt]) => ({ key, createdAt }));
  return { count: keys.length, keys };
}
