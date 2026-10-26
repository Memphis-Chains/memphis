import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  nativeRuntimeEnvironment,
  resetRuntimeConfigSnapshotForTests,
  resolveRuntimeConfigSnapshot,
} from '../../src/infra/config/runtime-config-snapshot.js';
import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const fixtures: string[] = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
  resetRuntimeConfigSnapshotForTests();
});

describe('runtime configuration snapshot', () => {
  it('pins provenance and generation and exports identical absolute paths to native', () => {
    const fixture = createIsolatedTestRuntime(process.env, process.cwd());
    fixtures.push(fixture.root);

    const first = resolveRuntimeConfigSnapshot(fixture.env);
    const same = resolveRuntimeConfigSnapshot(fixture.env);
    expect(first.schemaVersion).toBe(1);
    expect(first.runtimeRoot).toEqual({ path: fixture.root, source: 'env-override' });
    expect(first.dotenv).toEqual({
      path: `${fixture.root}/.env`,
      source: 'env-file',
    });
    expect(first.generation).toBeGreaterThan(0);
    expect(same.generation).toBe(first.generation);

    const next = resolveRuntimeConfigSnapshot({
      ...fixture.env,
      MEMPHIS_VAULT_STATE_PATH: `${fixture.root}/data/alternate-state.json`,
    });
    expect(next.generation).toBeGreaterThan(first.generation);
    expect(nativeRuntimeEnvironment(next, fixture.env)).toMatchObject({
      MEMPHIS_RUNTIME_ROOT: fixture.root,
      MEMPHIS_RUNTIME_ROOT_SOURCE: 'env-override',
      MEMPHIS_ENV_FILE: `${fixture.root}/.env`,
      MEMPHIS_DATA_DIR: `${fixture.root}/data`,
      MEMPHIS_VAULT_STATE_PATH: `${fixture.root}/data/alternate-state.json`,
      MEMPHIS_VAULT_ENTRIES_PATH: `${fixture.root}/data/vault-entries.json`,
      MEMPHIS_CONFIG_GENERATION: String(next.generation),
    });
  });
});
