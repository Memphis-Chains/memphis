import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// 2026-10-09: manifest.ts now uses the scoped helper `withVaultSecret`,
// which passes the plaintext to a callback and never returns it.
const { withVaultSecret, VaultSecretUnavailableError } = vi.hoisted(() => {
  class VaultSecretUnavailableError extends Error {
    constructor(key: string, reason: string) {
      super(`Vault secret "${key}" unavailable: ${reason}`);
      this.name = 'VaultSecretUnavailableError';
    }
  }
  return { withVaultSecret: vi.fn(), VaultSecretUnavailableError };
});

vi.mock('../../src/security/vault-boundary.js', () => ({
  withVaultSecret,
  VaultSecretUnavailableError,
}));

/** Queued answers for the scoped helper. `undefined` = raise unavailable. */
function queueSecrets(...values: Array<string | undefined>) {
  withVaultSecret.mockReset();
  for (const value of values) {
    withVaultSecret.mockImplementationOnce(
      (key: string, _ctx: unknown, fn: (p: string) => unknown) => {
        if (value === undefined) {
          throw new VaultSecretUnavailableError(String(key), 'no vault entry found');
        }
        return fn(value);
      },
    );
  }
}

import {
  type ManagedAppManifestRef,
  planManagedAppAction,
} from '../../src/modules/apps/manifest.js';
import { realTmpdir as tmpdir } from '../helpers/tmpdir.js';

function buildManifestRef(): ManagedAppManifestRef {
  return {
    source: { kind: 'builtin' },
    manifest: {
      schemaVersion: 1,
      id: 'demo-app',
      name: 'Demo App',
      description: 'demo app',
      capabilities: ['workspace', 'secrets'],
      platforms: [process.platform as 'linux' | 'darwin' | 'win32'],
      runtime: {
        commands: [],
        systemdUserService: false,
      },
      paths: {
        home: '${APP_ROOT}/home',
        state: '${APP_ROOT}/state',
        config: '${APP_ROOT}/config/app.json',
        expose: {},
      },
      actions: {
        install: {
          summary: 'install demo app',
          steps: ['printf ok'],
          env: {},
          requiresEnv: [],
          vaultEnv: {
            DEMO_TOKEN: 'DEMO_TOKEN',
          },
          vaultFiles: {
            '${APP_STATE_DIR}/token.txt': {
              key: 'DEMO_FILE_TOKEN',
              mode: '600',
            },
          },
        },
      },
      notes: [],
    },
  };
}

describe('managed apps vault boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves env and file secrets through bounded-use vault access', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-managed-app-boundary-'));
    const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;
    const ref = buildManifestRef();

    queueSecrets('secret-demo', 'secret-file-demo');

    const plan = planManagedAppAction(ref, 'install', { rawEnv });

    expect(plan.ok).toBe(true);
    expect(plan.exportedEnv.DEMO_TOKEN).toBeUndefined();
    expect(plan.secretBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: 'env',
          envName: 'DEMO_TOKEN',
          source: 'vault',
          status: 'pass',
        }),
        expect.objectContaining({
          target: 'file',
          source: 'vault',
          vaultKey: 'DEMO_FILE_TOKEN',
          status: 'pass',
        }),
      ]),
    );
    expect(withVaultSecret).toHaveBeenNthCalledWith(
      1,
      'DEMO_TOKEN',
      expect.objectContaining({
        surface: 'system',
        route: 'apps:manifest:vault-env',
        command: 'apps plan',
      }),
      expect.any(Function),
      rawEnv,
    );
    expect(withVaultSecret).toHaveBeenNthCalledWith(
      2,
      'DEMO_FILE_TOKEN',
      expect.objectContaining({
        surface: 'system',
        route: 'apps:manifest:vault-file',
        command: 'apps plan',
      }),
      expect.any(Function),
      rawEnv,
    );
  });

  it('fails closed when bounded-use vault access returns an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-managed-app-boundary-fail-'));
    const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;
    const ref = buildManifestRef();

    queueSecrets(undefined, undefined);

    const plan = planManagedAppAction(ref, 'install', { rawEnv });

    expect(plan.ok).toBe(false);
    expect(plan.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'secret-env:DEMO_TOKEN',
          ok: false,
        }),
      ]),
    );
  });
});
