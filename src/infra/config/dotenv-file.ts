import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse } from 'dotenv';

import { withConfigurationWriteLock } from './config-transaction.js';
import { writePrivateAtomicFile } from './private-atomic-file.js';
import { resolveInstallRoot } from '../runtime/install-root.js';
import { resolveVaultJournals, resolveVaultPath } from '../storage/vault-paths.js';

export function resolveDotEnvPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const explicit = rawEnv.MEMPHIS_ENV_FILE?.trim();
  if (explicit && explicit.length > 0) {
    return resolve(explicit);
  }
  // Default to `<installRoot>/.env` so `memphis` run from anywhere on the
  // machine reads the same config — previously this anchored on
  // `process.cwd()`, so `memphis tui` from `~` got empty defaults while
  // the same command from `~/memphis` got the full operator setup.
  try {
    return join(resolveInstallRoot({ rawEnv }), '.env');
  } catch {
    return resolve('.env');
  }
}

function assertGenericConfigMutation(keys: readonly string[], rawEnv: NodeJS.ProcessEnv): void {
  if (
    keys.includes('MEMPHIS_VAULT_PEPPER') &&
    existsSync(resolveVaultPath('vault-state.json', rawEnv))
  ) {
    throw new Error(
      'Initialized vault: use memphis vault pepper-rotate to change or remove the pepper.',
    );
  }
}

/** Shared boundary for generic dotenv writers, including the legacy CLI helpers. */
export function mutateDotEnvFile<T>(
  envPath: string,
  mutations: readonly { key: string; value?: string }[],
  rawEnv: NodeJS.ProcessEnv,
  mutate: (existing: string) => { content: string; result: T; write?: boolean },
): T {
  // Validate the complete batch before recovery or publication. Keys must not
  // smuggle an assignment; values must not introduce additional dotenv lines.
  for (const { key, value } of mutations) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error('Invalid configuration key.');
    }
    if (value !== undefined && /[\r\n]/.test(value)) {
      throw new Error('Configuration value must not contain newline characters.');
    }
  }
  const journals = resolveVaultJournals({ ...rawEnv, MEMPHIS_ENV_FILE: envPath }).paths;
  return withConfigurationWriteLock(journals, () => {
    // Even unrelated edits must recover pending rotations first, or they can
    // change the expected dotenv bytes and prevent the rotation from recovering.
    // Checking after recovery also serializes the guard with initialization.
    assertGenericConfigMutation(
      mutations.map(({ key }) => key),
      rawEnv,
    );
    const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    const next = mutate(existing);
    if (next.write !== false) {
      // Separate values containing quotes can consume existing lines without
      // containing a newline themselves. Compare the effective pepper as well
      // as the requested keys, before publishing any part of the batch.
      if (parse(existing).MEMPHIS_VAULT_PEPPER !== parse(next.content).MEMPHIS_VAULT_PEPPER) {
        assertGenericConfigMutation(['MEMPHIS_VAULT_PEPPER'], rawEnv);
      }
      writePrivateAtomicFile(envPath, next.content);
    }
    return next.result;
  });
}

export function setDotEnvValues(
  values: Record<string, string>,
  rawEnv: NodeJS.ProcessEnv = process.env,
): { path: string; updatedKeys: string[] } {
  const envPath = resolveDotEnvPath(rawEnv);
  const mutations = Object.entries(values).map(([key, value]) => ({ key, value }));
  return mutateDotEnvFile(envPath, mutations, rawEnv, (content) => {
    const existing = content ? content.split(/\r?\n/) : [];
    const nextLines = [...existing];
    const updatedKeys: string[] = [];

    for (const [key, value] of Object.entries(values)) {
      const rendered = `${key}=${value}`;
      const index = nextLines.findIndex((line) => line.startsWith(`${key}=`));
      if (index >= 0) {
        nextLines[index] = rendered;
      } else {
        nextLines.push(rendered);
      }
      updatedKeys.push(key);
    }

    const serialized = `${nextLines.filter((line, index, lines) => !(index === lines.length - 1 && line === '')).join('\n')}\n`;
    return { content: serialized, result: { path: envPath, updatedKeys } };
  });
}

export function unsetDotEnvValues(
  keys: readonly string[],
  rawEnv: NodeJS.ProcessEnv = process.env,
): { path: string; removedKeys: string[] } {
  const envPath = resolveDotEnvPath(rawEnv);
  return mutateDotEnvFile(
    envPath,
    keys.map((key) => ({ key })),
    rawEnv,
    (content) => {
      const existing = content ? content.split(/\r?\n/) : [];
      const keySet = new Set(keys);
      const filtered = existing.filter((line) => {
        const eq = line.indexOf('=');
        if (eq <= 0) return true;
        const key = line.slice(0, eq).trim();
        return !keySet.has(key);
      });

      const serialized = `${filtered.filter((line, index, lines) => !(index === lines.length - 1 && line === '')).join('\n')}\n`;
      return { content: serialized, result: { path: envPath, removedKeys: [...keySet] } };
    },
  );
}
