import { listVaultEntries, saveVaultEntry } from '../../infra/storage/vault-entry-store.js';
import { vaultDecrypt, vaultEncrypt, vaultInit } from '../../infra/storage/rust-vault-adapter.js';
import { embedReset } from '../../infra/storage/rust-embed-adapter.js';

export function runVaultInit(passphrase: string, recoveryQuestion: string, recoveryAnswer: string): string {
  const out = vaultInit(
    { passphrase, recovery_question: recoveryQuestion, recovery_answer: recoveryAnswer },
    process.env,
  );
  return `vault init: ok=true version=${out.version} did=${out.did}`;
}

export function runVaultAdd(key: string, value: string): string {
  const encrypted = vaultEncrypt(key, value, process.env);
  const stored = saveVaultEntry(encrypted, process.env);
  return `vault add: ok=true key=${stored.key} at=${stored.createdAt}`;
}

export function runVaultGet(key: string): string {
  const latest = listVaultEntries(process.env, key).at(-1);
  if (!latest) throw new Error(`vault key not found: ${key}`);
  const plaintext = vaultDecrypt(latest, process.env);
  return `vault get: key=${key} value=${plaintext}`;
}

export function runVaultList(key?: string): string {
  const entries = listVaultEntries(process.env, key);
  return `vault list: count=${entries.length}`;
}

export function runEmbedReset(): string {
  const out = embedReset(process.env);
  return `embed reset: cleared=${String(out.cleared)}`;
}
