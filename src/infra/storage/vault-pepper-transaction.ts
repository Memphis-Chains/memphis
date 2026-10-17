import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import dotenv from 'dotenv';

import { resetActiveVault, rotateVaultStatePepper, vaultDecrypt } from './rust-vault-adapter.js';
import { listVaultEntries, verifyVaultEntry } from './vault-entry-store.js';
import { resolveVaultJournals, resolveVaultPath } from './vault-paths.js';
import {
  commitConfigurationTransaction,
  configurationFileHash,
  recoverConfigurationTransaction,
} from '../config/config-transaction.js';
import { resolveDotEnvPath } from '../config/dotenv-file.js';
import { writePrivateAtomicFile } from '../config/private-atomic-file.js';

export function rotateVaultPepperAndConfig(
  oldPepper: string,
  newPepper: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
) {
  if (/[\r\n\0]/.test(newPepper)) throw new Error('Pepper must be a single line');
  const quote = ["'", '"', '`'].find((candidate) => !newPepper.includes(candidate));
  if (!quote) throw new Error('Pepper cannot contain every dotenv quoting delimiter');
  const envPath = resolveDotEnvPath(rawEnv);
  const journals = resolveVaultJournals({ ...rawEnv, MEMPHIS_ENV_FILE: envPath }).paths;
  recoverConfigurationTransaction(journals);
  const envContent = readFileSync(envPath, 'utf8');
  if (dotenv.parse(envContent).MEMPHIS_VAULT_PEPPER !== oldPepper)
    throw new Error('Persisted pepper differs from the supplied old pepper; reload configuration');
  const statePath = resolveVaultPath('vault-state.json', rawEnv);
  const stateHash = configurationFileHash(statePath);
  const envHash = configurationFileHash(envPath);
  // Validate every historical credential, not only a new cipher-cycle value.
  for (const entry of listVaultEntries(rawEnv)) {
    if (!verifyVaultEntry(entry)) throw new Error('Vault entry integrity failed before rotation');
    vaultDecrypt(entry, { ...rawEnv, MEMPHIS_VAULT_PEPPER: oldPepper });
  }
  const directory = `${envPath}.transactions`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const staged = join(directory, `prepared-${randomUUID()}.json`);
  try {
    writePrivateAtomicFile(staged, readFileSync(statePath, 'utf8'));
    const result = rotateVaultStatePepper(oldPepper, newPepper, {
      ...rawEnv,
      MEMPHIS_VAULT_STATE_PATH: staged,
    });
    const rendered = `MEMPHIS_VAULT_PEPPER=${quote}${newPepper}${quote}`;
    const lines = envContent
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:export\s+)?MEMPHIS_VAULT_PEPPER\s*=/.test(line));
    const nextEnv = `${lines.join('\n').trimEnd()}\n${rendered}\n`;
    // Round-trip before preparing durable intent: quoting must not alter bytes.
    if (dotenv.parse(nextEnv).MEMPHIS_VAULT_PEPPER !== newPepper)
      throw new Error('Pepper dotenv round-trip failed');
    commitConfigurationTransaction(journals, [
      { path: statePath, content: readFileSync(staged, 'utf8'), expectedHash: stateHash },
      { path: envPath, content: nextEnv, expectedHash: envHash },
    ]);
    return { ...result, statePath, envPath };
  } finally {
    resetActiveVault();
    // Same reasoning as writePrivateAtomicFile: throwing from `finally` would
    // mask a failed rotation with a cleanup error. The staged state file is a
    // staging artifact — report the leftover, keep the real cause visible.
    try {
      unlinkSync(staged);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(
          `[vault-pepper-transaction] leftover staged state ${staged} could not be removed: ${
            error instanceof Error ? error.message : 'unknown_error'
          }\n`,
        );
      }
    }
  }
}
