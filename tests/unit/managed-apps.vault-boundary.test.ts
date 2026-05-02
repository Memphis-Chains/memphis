import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useVaultSecretByKey } = vi.hoisted(() => ({
  useVaultSecretByKey: vi.fn(),
}));

vi.mock('../../src/security/vault-boundary.js', () => ({
  useVaultSecretByKey,
}));

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

    useVaultSecretByKey
      .mockReturnValueOnce({
        found: true,
        key: 'DEMO_TOKEN',
        plaintext: 'secret-demo',
      })
      .mockReturnValueOnce({
        found: true,
        key: 'DEMO_FILE_TOKEN',
        plaintext: 'secret-file-demo',
      });

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
    expect(useVaultSecretByKey).toHaveBeenNthCalledWith(
      1,
      'DEMO_TOKEN',
      expect.objectContaining({
        surface: 'system',
        route: 'apps:manifest:vault-env',
        command: 'apps plan',
      }),
      rawEnv,
    );
    expect(useVaultSecretByKey).toHaveBeenNthCalledWith(
      2,
      'DEMO_FILE_TOKEN',
      expect.objectContaining({
        surface: 'system',
        route: 'apps:manifest:vault-file',
        command: 'apps plan',
      }),
      rawEnv,
    );
  });

  it('fails closed when bounded-use vault access returns an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-managed-app-boundary-fail-'));
    const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;
    const ref = buildManifestRef();

    useVaultSecretByKey
      .mockReturnValueOnce({
        found: true,
        key: 'DEMO_TOKEN',
        error: 'Vault entry decryption failed',
      })
      .mockReturnValueOnce({
        found: false,
        key: 'DEMO_FILE_TOKEN',
      });

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
