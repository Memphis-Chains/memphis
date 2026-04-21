import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { resolveInstallRoot } from '../runtime/install-root.js';

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

export function setDotEnvValues(
  values: Record<string, string>,
  rawEnv: NodeJS.ProcessEnv = process.env,
): { path: string; updatedKeys: string[] } {
  const envPath = resolveDotEnvPath(rawEnv);
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
  writeFileSync(envPath, serialized, 'utf8');
  return { path: envPath, updatedKeys };
}

export function unsetDotEnvValues(
  keys: readonly string[],
  rawEnv: NodeJS.ProcessEnv = process.env,
): { path: string; removedKeys: string[] } {
  const envPath = resolveDotEnvPath(rawEnv);
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
  const keySet = new Set(keys);
  const filtered = existing.filter((line) => {
    const eq = line.indexOf('=');
    if (eq <= 0) return true;
    const key = line.slice(0, eq).trim();
    return !keySet.has(key);
  });

  const serialized = `${filtered.filter((line, index, lines) => !(index === lines.length - 1 && line === '')).join('\n')}\n`;
  writeFileSync(envPath, serialized, 'utf8');
  return { path: envPath, removedKeys: [...keySet] };
}
