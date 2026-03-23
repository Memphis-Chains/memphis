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
}

/**
 * Retrieve and decrypt a vault secret by key name.
 * Requires Rust bridge — returns a clear error if unavailable.
 */
export function runMemphisVaultGet(input: VaultGetInput): VaultGetOutput {
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
 */
export function runMemphisVaultList(): VaultListOutput {
  const entries = listVaultEntries();
  const seen = new Map<string, string>();
  for (const e of entries) {
    // Keep latest createdAt per key
    seen.set(e.key, e.createdAt);
  }
  const keys = [...seen.entries()].map(([key, createdAt]) => ({ key, createdAt }));
  return { count: keys.length, keys };
}
