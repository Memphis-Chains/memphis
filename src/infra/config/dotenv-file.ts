import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

function configurationWriteJournals(
  keys: readonly string[],
  envPath: string,
  rawEnv: NodeJS.ProcessEnv,
): string | readonly string[] {
  if (!keys.includes('MEMPHIS_VAULT_PEPPER')) return envPath;
  return resolveVaultJournals({ ...rawEnv, MEMPHIS_ENV_FILE: envPath }).paths;
}

export function setDotEnvValues(
  values: Record<string, string>,
  rawEnv: NodeJS.ProcessEnv = process.env,
): { path: string; updatedKeys: string[] } {
  const envPath = resolveDotEnvPath(rawEnv);
  const keys = Object.keys(values);
  return withConfigurationWriteLock(configurationWriteJournals(keys, envPath, rawEnv), () => {
    // Check after acquiring both the state and dotenv journals. Otherwise a
    // generic pepper write could race vault initialization and strand the
    // just-created vault with a different pepper.
    assertGenericConfigMutation(keys, rawEnv);
    const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
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
    writePrivateAtomicFile(envPath, serialized);
    return { path: envPath, updatedKeys };
  });
}

export function unsetDotEnvValues(
  keys: readonly string[],
  rawEnv: NodeJS.ProcessEnv = process.env,
): { path: string; removedKeys: string[] } {
  const envPath = resolveDotEnvPath(rawEnv);
  return withConfigurationWriteLock(configurationWriteJournals(keys, envPath, rawEnv), () => {
    assertGenericConfigMutation(keys, rawEnv);
    const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
    const keySet = new Set(keys);
    const filtered = existing.filter((line) => {
      const eq = line.indexOf('=');
      if (eq <= 0) return true;
      const key = line.slice(0, eq).trim();
      return !keySet.has(key);
    });

    const serialized = `${filtered.filter((line, index, lines) => !(index === lines.length - 1 && line === '')).join('\n')}\n`;
    writePrivateAtomicFile(envPath, serialized);
    return { path: envPath, removedKeys: [...keySet] };
  });
}
