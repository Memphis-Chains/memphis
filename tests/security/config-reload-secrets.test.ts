import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { performHotReload, performHotReloadSync } from '../../src/infra/config/hot-reload.js';
import {
  clearPostApplyHooks,
  registerPostApplyHook,
} from '../../src/infra/config/post-apply-hooks.js';
import {
  getActiveRuntimeConfigSnapshot,
  initializeRuntimeConfigSnapshot,
  resetRuntimeConfigSnapshotForTests,
} from '../../src/infra/config/runtime-config-snapshot.js';
import { runMemphisConfigShow } from '../../src/mcp/tools/config.js';
import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

let fixture: ReturnType<typeof createIsolatedTestRuntime>;
let previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = process.env;
  fixture = createIsolatedTestRuntime(previous, resolve('.'));
  process.env = fixture.env;
  process.env.GEN_MAX_TOKENS = '1024';
  resetRuntimeConfigSnapshotForTests();
  clearPostApplyHooks();
  initializeRuntimeConfigSnapshot();
});
afterEach(() => {
  process.env = previous;
  resetRuntimeConfigSnapshotForTests();
  clearPostApplyHooks();
  rmSync(fixture.root, { recursive: true, force: true });
});

it.each([
  ['DATABASE_URL', 'postgresql://fixture-user:synthetic-private-url-value@localhost/memphis'],
  ['MINIMAX_BASE_URL', 'https://example.invalid/v1?access_token=synthetic-private-url-value'],
  ['DATABASE_URL', 'postgresql://fixture-user:synthetic-private-url-value@/'],
  ['MINIMAX_BASE_URL', 'https://example.invalid/v1#access_token=synthetic-private-url-value'],
])('redacts credential-bearing %s values in public configuration inspection', (key, value) => {
  process.env[key] = value;
  const result = runMemphisConfigShow({ key });
  expect(result.values[key]).toBe('***redacted***');
  expect(JSON.stringify(result)).not.toContain('synthetic-private-url-value');
});

it('keeps unknown private env values out of reload results', () => {
  const oldValue = 'synthetic-private-legacy-old';
  const newValue = 'synthetic-private-legacy-new';
  process.env.OPERATOR_LEGACY_TOKEN = oldValue;
  writeFileSync(fixture.env.MEMPHIS_ENV_FILE!, `OPERATOR_LEGACY_TOKEN=${newValue}\n`);
  const result = performHotReloadSync();
  expect(result.ok).toBe(true);
  expect(process.env.OPERATOR_LEGACY_TOKEN).toBe(newValue);
  expect(JSON.stringify(result)).not.toContain(oldValue);
  expect(JSON.stringify(result)).not.toContain(newValue);
});

it('keeps a normal provider URL visible', () => {
  process.env.MINIMAX_BASE_URL = 'https://example.invalid/v1';
  expect(runMemphisConfigShow({ key: 'MINIMAX_BASE_URL' }).values.MINIMAX_BASE_URL).toBe(
    'https://example.invalid/v1',
  );
});

it('vetoes a generic pepper reload for an existing vault without applying other changes', () => {
  const oldPepper = 'synthetic-private-reload-old';
  const newPepper = 'synthetic-private-reload-new';
  process.env.MEMPHIS_VAULT_PEPPER = oldPepper;
  const state = JSON.stringify({
    salt: Buffer.alloc(32, 1).toString('base64'),
    masterKey: Buffer.alloc(32, 2).toString('base64'),
  });
  writeFileSync(fixture.env.MEMPHIS_VAULT_STATE_PATH!, state);
  const incoming = `MEMPHIS_VAULT_PEPPER=${newPepper}\nGEN_MAX_TOKENS=2048\n`;
  writeFileSync(fixture.env.MEMPHIS_ENV_FILE!, incoming);
  const snapshot = getActiveRuntimeConfigSnapshot();
  const result = performHotReloadSync({ allowCold: true });
  expect(JSON.stringify(result)).not.toContain(oldPepper);
  expect(JSON.stringify(result)).not.toContain(newPepper);
  expect(result.ok).toBe(false);
  expect(result.appliedCount).toBe(0);
  expect(result.rejectedCold).toContain('MEMPHIS_VAULT_PEPPER');
  expect(process.env.MEMPHIS_VAULT_PEPPER).toBe(oldPepper);
  expect(process.env.GEN_MAX_TOKENS).toBe('1024');
  expect(getActiveRuntimeConfigSnapshot()).toBe(snapshot);
  expect(readFileSync(fixture.env.MEMPHIS_VAULT_STATE_PATH!, 'utf8')).toBe(state);
  expect(readFileSync(fixture.env.MEMPHIS_ENV_FILE!, 'utf8')).toBe(incoming);
});

it('keeps credential-bearing async hook exceptions out of reload results', async () => {
  const sentinel = 'synthetic-private-hook-rejection';
  writeFileSync(fixture.env.MEMPHIS_ENV_FILE!, 'GEN_MAX_TOKENS=2048\n');
  registerPostApplyHook('GEN_MAX_TOKENS', 'synthetic-fixture-hook', async () => {
    await Promise.resolve();
    throw new Error(sentinel, { cause: { headers: { Authorization: sentinel } } });
  });
  const result = await performHotReload();
  expect(result.hookOutcomes).toMatchObject([{ ok: false }]);
  expect(JSON.stringify(result)).not.toContain(sentinel);
});
