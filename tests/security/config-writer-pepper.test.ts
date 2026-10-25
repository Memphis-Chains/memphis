import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { parse } from 'dotenv';
import { afterEach, describe, expect, it } from 'vitest';

import {
  configurationFileHash,
  withConfigurationWriteLock,
} from '../../src/infra/config/config-transaction.js';
import { setDotEnvValues, unsetDotEnvValues } from '../../src/infra/config/dotenv-file.js';
import { removeEnvVars, upsertEnvVars } from '../../src/infra/config/env-file.js';
import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const originalEnv = process.env;
const roots: string[] = [];
const pepperKey = 'MEMPHIS_VAULT_PEPPER';
const original = `${pepperKey}=synthetic-existing-pepper\nOTHER=keep\n`;
afterEach(() => {
  process.env = originalEnv;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fixture(initialized = true) {
  const f = createIsolatedTestRuntime(originalEnv, resolve('.'));
  roots.push(f.root);
  process.env = f.env;
  const envPath = f.env.MEMPHIS_ENV_FILE!;
  const statePath = f.env.MEMPHIS_VAULT_STATE_PATH!;
  writeFileSync(envPath, original, { mode: 0o600 });
  if (initialized) writeFileSync(statePath, '{}', { mode: 0o600 });
  return { ...f, envPath, statePath };
}

const writers = [
  {
    name: 'dotenv',
    set: (values: Record<string, string>, envPath: string) =>
      setDotEnvValues(values, { ...process.env, MEMPHIS_ENV_FILE: envPath }),
    unset: (keys: string[], envPath: string) =>
      unsetDotEnvValues(keys, { ...process.env, MEMPHIS_ENV_FILE: envPath }),
  },
  {
    name: 'legacy env-file',
    set: (values: Record<string, string>, envPath: string) =>
      upsertEnvVars(
        Object.entries(values).map(([key, value]) => ({ key, value })),
        envPath,
      ),
    unset: (keys: string[], envPath: string) => removeEnvVars(keys, envPath),
  },
];

describe.each(writers)('$name generic pepper protection', (writer) => {
  it.each(['synthetic-replacement', ''])(
    'refuses replacement/clear without a partial batch',
    (value) => {
      const f = fixture();
      expect(() => writer.set({ OTHER: 'changed', [pepperKey]: value }, f.envPath)).toThrow(
        /pepper-rotate/,
      );
      expect(readFileSync(f.envPath, 'utf8')).toBe(original);
      expect(readFileSync(f.statePath, 'utf8')).toBe('{}');
    },
  );

  it('refuses removal without partially removing unrelated fields', () => {
    const f = fixture();
    expect(() => writer.unset(['OTHER', pepperKey], f.envPath)).toThrow(/pepper-rotate/);
    expect(readFileSync(f.envPath, 'utf8')).toBe(original);
  });

  it('serializes first-run pepper setup with initialization and dotenv writers', () => {
    const f = fixture(false);
    writer.set({ [pepperKey]: 'synthetic-first-run-pepper' }, f.envPath);
    for (const path of [f.envPath, f.statePath])
      expect(existsSync(`${path}.transactions/journal.sqlite`)).toBe(true);
    expect(readFileSync(f.envPath, 'utf8')).toContain('synthetic-first-run-pepper');
    expect(existsSync(f.statePath)).toBe(false);
  });

  it('rechecks initialization after recovering the vault journal', () => {
    const f = fixture(false);
    withConfigurationWriteLock([f.statePath, f.envPath], () => undefined);
    const db = new Database(`${f.statePath}.transactions/journal.sqlite`);
    try {
      db.prepare(
        "INSERT INTO transactions(status, updates, previous, created_at) VALUES ('prepared', ?, ?, ?)",
      ).run(
        JSON.stringify([{ path: f.statePath, content: '{}', expectedHash: null }]),
        JSON.stringify([{ path: f.statePath, content: null }]),
        '2026-10-18T00:00:00Z',
      );
    } finally {
      db.close();
    }
    expect(() => writer.set({ [pepperKey]: 'synthetic-replacement' }, f.envPath)).toThrow(
      /pepper-rotate/,
    );
    expect(readFileSync(f.envPath, 'utf8')).toBe(original);
    expect(readFileSync(f.statePath, 'utf8')).toBe('{}');
  });

  it.each(['\n', '\r'])(
    'refuses assignment injection through a value containing %j',
    (separator) => {
      const f = fixture();
      expect(() =>
        writer.set({ OTHER: `changed${separator}${pepperKey}=synthetic-injected` }, f.envPath),
      ).toThrow(/newline/);
      expect(readFileSync(f.envPath, 'utf8')).toBe(original);
    },
  );

  it('refuses assignment injection through a key', () => {
    const f = fixture();
    expect(() =>
      writer.set({ [`OTHER=changed\n${pepperKey}`]: 'synthetic-injected' }, f.envPath),
    ).toThrow(/configuration key/);
    expect(readFileSync(f.envPath, 'utf8')).toBe(original);
  });

  it('refuses indirect pepper removal through quotes spanning existing lines', () => {
    const f = fixture();
    const content = `OTHER=keep\n${pepperKey}=synthetic-existing-pepper\nTAIL=end\n`;
    writeFileSync(f.envPath, content);
    expect(() => writer.set({ OTHER: '"open', TAIL: 'end"' }, f.envPath)).toThrow(/pepper-rotate/);
    expect(readFileSync(f.envPath, 'utf8')).toBe(content);
  });

  it('recovers a pending rotation before editing an unrelated field', () => {
    const f = fixture();
    withConfigurationWriteLock([f.statePath, f.envPath], () => undefined);
    const db = new Database(`${f.statePath}.transactions/journal.sqlite`);
    const recovered = original.replace('synthetic-existing-pepper', 'synthetic-rotated-pepper');
    try {
      db.prepare(
        "INSERT INTO transactions(status, updates, previous, created_at) VALUES ('prepared', ?, ?, ?)",
      ).run(
        JSON.stringify([
          { path: f.envPath, content: recovered, expectedHash: configurationFileHash(f.envPath) },
          {
            path: f.statePath,
            content: '{"recovered":true}',
            expectedHash: configurationFileHash(f.statePath),
          },
        ]),
        '[]',
        '2026-10-19T00:00:00Z',
      );
    } finally {
      db.close();
    }
    writer.set({ OTHER: 'changed' }, f.envPath);
    expect(parse(readFileSync(f.envPath))).toEqual({
      [pepperKey]: 'synthetic-rotated-pepper',
      OTHER: 'changed',
    });
    expect(readFileSync(f.statePath, 'utf8')).toBe('{"recovered":true}');
  });

  it('still updates and removes ordinary fields on an initialized vault', () => {
    const f = fixture();
    writer.set({ OTHER: 'changed', NEW_FIELD: 'value' }, f.envPath);
    writer.unset(['OTHER', 'NEW_FIELD'], f.envPath);
    expect(parse(readFileSync(f.envPath))).toEqual({ [pepperKey]: 'synthetic-existing-pepper' });
    expect(readFileSync(f.statePath, 'utf8')).toBe('{}');
  });
});
