import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
describe('secret CLI operation JSON and process exit', () => {
  it.each([
    ['list', '[]', 0, undefined],
    ['get', '[]', 1, 'VAULT_ENTRY_NOT_FOUND'],
    ['list', '{synthetic-private-store-content', 1, 'VAULT_ENTRIES_MALFORMED'],
    ['get', '{synthetic-private-store-content', 1, 'VAULT_ENTRIES_MALFORMED'],
    ['add', '{synthetic-private-store-content', 1, 'VAULT_SECRET_WRITE_FAILED'],
  ] as const)(
    '%s yields a coherent JSON result and exit for an isolated store',
    (operation, entries, status, code) => {
      const f = createIsolatedTestRuntime(process.env, resolve('.'));
      roots.push(f.root);
      delete f.env.MEMPHIS_VAULT_PEPPER;
      const state = JSON.stringify({
        salt: Buffer.alloc(32, 1).toString('base64'),
        masterKey: Buffer.alloc(32, 2).toString('base64'),
      });
      writeFileSync(f.env.MEMPHIS_VAULT_STATE_PATH!, state, { mode: 0o600 });
      writeFileSync(f.env.MEMPHIS_VAULT_ENTRIES_PATH!, entries, { mode: 0o600 });
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'tests/helpers/secret-cli-process.mts', operation],
        { cwd: resolve('.'), env: f.env, encoding: 'utf8', timeout: 30000 },
      );
      expect(child.status, child.stderr).toBe(status);
      const data = JSON.parse(child.stdout) as { ok: boolean; code?: string };
      expect(data.ok).toBe(status === 0);
      if (code) expect(data.code).toBe(code);
      expect(child.stdout + child.stderr).not.toContain('synthetic-private-store-content');
      expect(child.stdout + child.stderr).not.toContain('synthetic-private-provided-value');
      expect(readFileSync(f.env.MEMPHIS_VAULT_STATE_PATH!, 'utf8')).toBe(state);
      expect(readFileSync(f.env.MEMPHIS_VAULT_ENTRIES_PATH!, 'utf8')).toBe(entries);
    },
  );
});
