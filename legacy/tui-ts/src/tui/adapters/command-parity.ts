import { embedReset } from '../../infra/storage/rust-embed-adapter.js';
import {
  initializeVault,
  listVaultEntryMetadata,
  readVaultSecretByKey,
  storeVaultSecret,
} from '../../security/vault-boundary.js';

export function runVaultInit(
  passphrase: string,
  recoveryQuestion: string,
  recoveryAnswer: string,
): string {
  const out = initializeVault(
    { passphrase, recovery_question: recoveryQuestion, recovery_answer: recoveryAnswer },
    { surface: 'tui', command: 'vault init' },
    process.env,
  );
  return `vault init: ok=true version=${out.version} did=${out.did}`;
}

export function runVaultAdd(key: string, value: string): string {
  const stored = storeVaultSecret(
    key,
    value,
    { surface: 'tui', command: 'vault add' },
    process.env,
  );
  return `vault add: ok=true key=${stored.key} at=${stored.createdAt}`;
}

export function runVaultGet(key: string): string {
  const result = readVaultSecretByKey(key, { surface: 'tui', command: 'vault get' }, process.env);
  if (!result.found) throw new Error(`vault key not found: ${key}`);
  if (result.error) throw new Error(result.error);
  return `vault get: key=${key} value=${result.plaintext}`;
}

export function runVaultList(key?: string): string {
  const entries = listVaultEntryMetadata(
    { surface: 'tui', command: 'vault list' },
    process.env,
    key,
    { latestPerKey: true },
  );
  const keys = entries.map((entry) => entry.key).join(', ');
  return `vault list: count=${entries.length}${keys ? ` keys=${keys}` : ''}`;
}

export function runEmbedReset(): string {
  const out = embedReset(process.env);
  return `embed reset: cleared=${String(out.cleared)}`;
}
