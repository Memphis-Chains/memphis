import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMatrixSetup } from '../../src/infra/cli/commands/setup-matrix.js';

function createTempMatrixPaths(): { composePath: string; homeserverPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), 'memphis-matrix-setup-'));
  const composePath = join(tempDir, 'matrix.yaml');
  const homeserverPath = join(tempDir, 'synapse', 'homeserver.generated.yaml');
  writeFileSync(composePath, 'services: {}\n', 'utf8');
  return { composePath, homeserverPath };
}

function makeStoredEntry(key: string) {
  return {
    id: `${key}-entry`,
    key,
    createdAt: '2026-03-26T10:00:00.000Z',
    fingerprint: `fp-${key}`,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runMatrixSetup', () => {
  it('stores pilot secrets in vault and emits a vault-backed access token only when a real token exists', async () => {
    const { composePath, homeserverPath } = createTempMatrixPaths();
    const storedKeys: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const execCommand = vi.fn((cmd: string) => {
      if (cmd.startsWith('docker ps')) return 'container-123';
      return '';
    });
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/register')) {
        return new Response(JSON.stringify({ access_token: 'matrix-access-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await runMatrixSetup({
      json: true,
      serverName: 'matrix.test',
      adminUser: 'pilot_admin',
      dockerComposePath: composePath,
      homeserverConfigPath: homeserverPath,
      deps: {
        checkPrereqs: () => ({ ok: true, errors: [], warnings: [] }),
        checkDockerRunning: () => true,
        execCommand,
        waitForSynapse: async () => true,
        fetchFn: fetchFn as typeof fetch,
        storeVaultSecret: ((key: string) => {
          storedKeys.push(key);
          return makeStoredEntry(key);
        }) as typeof import('../../src/security/vault-boundary.js').storeVaultSecret,
        probeVaultCipherCycle: (() => ({
          ok: true,
        })) as typeof import('../../src/security/vault-boundary.js').probeVaultCipherCycle,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.pilotReady).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.storedVaultKeys).toEqual([
      'MEMPHIS_MATRIX_REGISTRATION_SHARED_SECRET',
      'MEMPHIS_MATRIX_ADMIN_PASSWORD',
      'MEMPHIS_MATRIX_ACCESS_TOKEN',
    ]);
    expect(storedKeys).toEqual(result.storedVaultKeys);
    expect(result.matrixConfig).toEqual(
      expect.objectContaining({
        MEMPHIS_MATRIX_ENABLED: 'true',
        MEMPHIS_MATRIX_HOMESERVER: 'http://localhost:8008',
        MEMPHIS_MATRIX_SERVER_NAME: 'matrix.test',
        MEMPHIS_MATRIX_ADMIN_USER: 'pilot_admin',
        MEMPHIS_MATRIX_TRUST_MODE: 'trusted-pilot',
        MEMPHIS_MATRIX_ACCESS_TOKEN: 'VAULT:MEMPHIS_MATRIX_ACCESS_TOKEN',
      }),
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(existsSync(homeserverPath)).toBe(true);
    const homeserverConfig = readFileSync(homeserverPath, 'utf8');
    expect(homeserverConfig).toContain('server_name: "matrix.test"');
    expect(homeserverConfig).not.toContain('${SYNAPSE_REGISTRATION_SHARED_SECRET}');
    expect(homeserverConfig).not.toContain('${SYNAPSE_MACAROON_SECRET_KEY}');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('returns manual follow-up steps instead of inventing pilot readiness when no real token was acquired', async () => {
    const { composePath, homeserverPath } = createTempMatrixPaths();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const result = await runMatrixSetup({
      json: true,
      dockerComposePath: composePath,
      homeserverConfigPath: homeserverPath,
      deps: {
        checkPrereqs: () => ({ ok: true, errors: [], warnings: [] }),
        checkDockerRunning: () => true,
        execCommand: ((cmd: string) => {
          void cmd;
          return 'container-123';
        }) as (cmd: string, options?: { cwd?: string; stdio?: 'inherit' | 'pipe' }) => string,
        waitForSynapse: async () => true,
        fetchFn: fetchFn as typeof fetch,
        storeVaultSecret: ((key: string) =>
          makeStoredEntry(
            key,
          )) as typeof import('../../src/security/vault-boundary.js').storeVaultSecret,
        probeVaultCipherCycle: (() => ({
          ok: true,
        })) as typeof import('../../src/security/vault-boundary.js').probeVaultCipherCycle,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.pilotReady).toBe(false);
    expect(result.matrixConfig).toEqual(
      expect.objectContaining({
        MEMPHIS_MATRIX_ENABLED: 'true',
        MEMPHIS_MATRIX_HOMESERVER: 'http://localhost:8008',
        MEMPHIS_MATRIX_TRUST_MODE: 'trusted-pilot',
      }),
    );
    expect(result.matrixConfig).not.toHaveProperty('MEMPHIS_MATRIX_ACCESS_TOKEN');
    expect(result.storedVaultKeys).toEqual([
      'MEMPHIS_MATRIX_REGISTRATION_SHARED_SECRET',
      'MEMPHIS_MATRIX_ADMIN_PASSWORD',
    ]);
    expect(result.manualSteps.join('\n')).toContain('MEMPHIS_MATRIX_ACCESS_TOKEN');
    expect(result.warnings.join('\n')).toContain('did not acquire an access token automatically');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the local vault is not initialized', async () => {
    const { composePath, homeserverPath } = createTempMatrixPaths();
    const execCommand = vi.fn(() => '');

    const result = await runMatrixSetup({
      json: true,
      dockerComposePath: composePath,
      homeserverConfigPath: homeserverPath,
      deps: {
        checkPrereqs: () => ({ ok: true, errors: [], warnings: [] }),
        checkDockerRunning: () => true,
        execCommand,
        waitForSynapse: async () => true,
        fetchFn: fetch as typeof fetch,
        storeVaultSecret: ((key: string) =>
          makeStoredEntry(
            key,
          )) as typeof import('../../src/security/vault-boundary.js').storeVaultSecret,
        probeVaultCipherCycle: (() => ({
          ok: false,
          error: 'Vault encryption cycle failed',
        })) as typeof import('../../src/security/vault-boundary.js').probeVaultCipherCycle,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('requires an initialized local vault');
    expect(execCommand).not.toHaveBeenCalled();
    expect(existsSync(homeserverPath)).toBe(false);
  });
});
