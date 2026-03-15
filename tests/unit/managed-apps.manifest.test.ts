import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { vaultEncrypt } from '../../src/infra/storage/rust-vault-adapter.js';
import { saveVaultEntry } from '../../src/infra/storage/vault-entry-store.js';
import {
  describeManagedAppManifest,
  executeManagedAppAction,
  getManagedAppManifest,
  importManagedAppManifestFile,
  inspectManagedAppCatalog,
  listManagedAppManifestRefs,
  planManagedAppAction,
  validateManagedAppManifestFile,
} from '../../src/modules/apps/manifest.js';

describe('managed app manifests', () => {
  it('loads user-managed manifests from the Memphis manifests directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-apps-list-'));
    const manifestsDir = join(dir, 'apps', 'manifests');
    mkdirSync(manifestsDir, { recursive: true });
    writeFileSync(
      join(manifestsDir, 'demo.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: 'demo-app',
          name: 'Demo App',
          description: 'demo app in managed manifests dir',
          capabilities: ['workspace', 'secrets'],
          actions: {
            doctor: {
              summary: 'print readiness token',
              steps: ['printf ready'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const manifests = listManagedAppManifestRefs({ MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv);
    expect(manifests.map((item) => item.manifest.id)).toContain('demo-app');
    const demo = manifests.find((item) => item.manifest.id === 'demo-app');
    expect(describeManagedAppManifest(demo!).actions).toEqual(['doctor']);
    expect(describeManagedAppManifest(demo!).capabilities).toEqual(['secrets', 'workspace']);
    expect(describeManagedAppManifest(demo!).capabilityGuidance).toEqual([
      expect.stringContaining('Workspace:'),
      expect.stringContaining('Secrets:'),
    ]);
    expect(describeManagedAppManifest(demo!).capabilityWarnings).toEqual([]);
  });

  it('plans a file-backed install action with Memphis-managed paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-app-plan-'));
    const manifestPath = join(dir, 'demo.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          id: 'demo-app',
          name: 'Demo App',
          description: 'demo app for path planning',
          capabilities: ['workspace'],
          actions: {
            install: {
              summary: 'print install token',
              steps: ['printf install-ready'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const rawEnv = { MEMPHIS_DATA_DIR: '/tmp/memphis-apps' } as NodeJS.ProcessEnv;
    const ref = getManagedAppManifest({ file: manifestPath, rawEnv });
    const plan = planManagedAppAction(ref, 'install', { rawEnv });

    expect(plan.paths.appRoot).toBe('/tmp/memphis-apps/apps/demo-app');
    expect(plan.paths.home).toBe('/tmp/memphis-apps/apps/demo-app/home');
    expect(plan.paths.state).toBe('/tmp/memphis-apps/apps/demo-app/state');
    expect(plan.paths.config).toBe('/tmp/memphis-apps/apps/demo-app/config/app.json');
    expect(plan.exportedEnv.APP_HOME).toBe('/tmp/memphis-apps/apps/demo-app/home');
    expect(plan.exportedEnv.APP_STATE_DIR).toBe('/tmp/memphis-apps/apps/demo-app/state');
    expect(plan.exportedEnv.APP_CONFIG_PATH).toBe(
      '/tmp/memphis-apps/apps/demo-app/config/app.json',
    );
    expect(plan.manifest.capabilities).toEqual(['workspace']);
    expect(plan.manifest.capabilityGuidance).toEqual([expect.stringContaining('Workspace:')]);
    expect(plan.steps).toEqual(['printf install-ready']);
  });

  it('inspects managed app catalogs without crashing on invalid manifests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-app-catalog-'));
    const manifestsDir = join(dir, 'apps', 'manifests');
    mkdirSync(manifestsDir, { recursive: true });
    writeFileSync(
      join(manifestsDir, 'good.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: 'demo-mcp-app',
          name: 'Demo MCP App',
          description: 'valid app for catalog inspection',
          capabilities: ['mcp', 'workspace'],
          actions: {
            status: {
              summary: 'print status',
              steps: ['printf status-ready'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(join(manifestsDir, 'bad.json'), '{"schemaVersion":1,"id":"broken"', 'utf8');

    const catalog = inspectManagedAppCatalog({ MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv);

    expect(catalog.manifests.map((item) => item.manifest.id)).toEqual(['demo-mcp-app']);
    expect(catalog.capabilityCounts.mcp).toBe(1);
    expect(catalog.capabilityCounts.workspace).toBe(1);
    expect(catalog.errors).toEqual([
      expect.objectContaining({
        path: expect.stringContaining('bad.json'),
      }),
    ]);
  });

  it('describes capability warnings for structural pattern gaps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-app-warning-hints-'));
    const manifestPath = join(dir, 'demo.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          id: 'browser-memory-app',
          name: 'Browser Memory App',
          description: 'demo app for pattern warning coverage',
          capabilities: ['browser', 'memory'],
          actions: {
            status: {
              summary: 'print status',
              steps: ['printf status-ready'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const ref = getManagedAppManifest({
      file: manifestPath,
      rawEnv: { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv,
    });
    const summary = describeManagedAppManifest(ref);

    expect(summary.capabilityWarnings).toEqual([
      'memory tag without workspace/service scope',
      'browser tag without mcp/service transport hint',
    ]);
  });

  it('executes a file-backed managed app action when apply is requested', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-app-manifest-'));
    const manifestPath = join(dir, 'demo.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          id: 'demo-app',
          name: 'Demo App',
          description: 'demo app for managed app execution tests',
          actions: {
            doctor: {
              summary: 'print readiness token',
              steps: ['printf ready'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;
    const ref = getManagedAppManifest({ file: manifestPath, rawEnv });
    const result = executeManagedAppAction(ref, 'doctor', { rawEnv, apply: true });

    expect(result.executed).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.stdout).toContain('ready');
    expect(result.paths.appRoot).toBe(join(dir, 'apps', 'demo-app'));
  });

  it('resolves vault-backed env bindings without exposing secret values in the plan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-app-vault-plan-'));
    const bridgePath = join(dir, 'mock-bridge.cjs');
    const entriesPath = join(dir, 'vault-entries.json');
    const manifestPath = join(dir, 'demo.json');

    writeFileSync(
      bridgePath,
      `module.exports = {
  vault_init: () => JSON.stringify({ ok: true, data: { version: 1, did: 'did:memphis:apps' } }),
  vault_encrypt: (key, plaintext) => JSON.stringify({ ok: true, data: { key, encrypted: 'enc:' + plaintext, iv: 'iv' } }),
  vault_decrypt: (entryJson) => {
    const e = JSON.parse(entryJson);
    return JSON.stringify({ ok: true, data: { plaintext: String(e.encrypted).replace('enc:', '') } });
  }
};`,
      'utf8',
    );

    const rawEnv = {
      MEMPHIS_DATA_DIR: dir,
      MEMPHIS_VAULT_ENTRIES_PATH: entriesPath,
      MEMPHIS_VAULT_PEPPER: 'very-secure-pepper',
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
    } as NodeJS.ProcessEnv;

    saveVaultEntry(vaultEncrypt('DEMO_TOKEN', 'secret-demo', rawEnv), rawEnv);

    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          id: 'demo-app',
          name: 'Demo App',
          description: 'demo app for vault-backed env planning',
          actions: {
            install: {
              summary: 'install demo app with vault-backed token',
              steps: ['test "$DEMO_TOKEN" = "secret-demo" && printf install-ready'],
              vaultEnv: {
                DEMO_TOKEN: 'DEMO_TOKEN',
              },
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const ref = getManagedAppManifest({ file: manifestPath, rawEnv });
    const plan = planManagedAppAction(ref, 'install', { rawEnv });

    expect(plan.ok).toBe(true);
    expect(plan.secretBindings).toEqual([
      expect.objectContaining({
        envName: 'DEMO_TOKEN',
        source: 'vault',
        status: 'pass',
        ok: true,
        vaultKey: 'DEMO_TOKEN',
      }),
    ]);
    expect(plan.requirements.find((item) => item.id === 'secret-env:DEMO_TOKEN')?.ok).toBe(true);
    expect(plan.exportedEnv.DEMO_TOKEN).toBeUndefined();
  });

  it('fails closed when a vault-backed env binding is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-app-vault-missing-'));
    const manifestPath = join(dir, 'demo.json');

    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          id: 'demo-app',
          name: 'Demo App',
          description: 'demo app for missing secret validation',
          actions: {
            install: {
              summary: 'require vault-backed token',
              steps: ['printf should-not-run'],
              vaultEnv: {
                DEMO_TOKEN: 'DEMO_TOKEN',
              },
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;
    const ref = getManagedAppManifest({ file: manifestPath, rawEnv });
    const plan = planManagedAppAction(ref, 'install', { rawEnv });

    expect(plan.ok).toBe(false);
    expect(plan.secretBindings).toEqual([
      expect.objectContaining({
        envName: 'DEMO_TOKEN',
        source: 'vault',
        status: 'fail',
        ok: false,
        vaultKey: 'DEMO_TOKEN',
      }),
    ]);
    expect(plan.requirements.find((item) => item.id === 'secret-env:DEMO_TOKEN')?.ok).toBe(false);
  });

  it('materializes vault-backed secret files before executing action steps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-app-vault-file-'));
    const bridgePath = join(dir, 'mock-bridge.cjs');
    const entriesPath = join(dir, 'vault-entries.json');
    const manifestPath = join(dir, 'demo.json');

    writeFileSync(
      bridgePath,
      `module.exports = {
  vault_init: () => JSON.stringify({ ok: true, data: { version: 1, did: 'did:memphis:apps-file' } }),
  vault_encrypt: (key, plaintext) => JSON.stringify({ ok: true, data: { key, encrypted: 'enc:' + plaintext, iv: 'iv' } }),
  vault_decrypt: (entryJson) => {
    const e = JSON.parse(entryJson);
    return JSON.stringify({ ok: true, data: { plaintext: String(e.encrypted).replace('enc:', '') } });
  }
};`,
      'utf8',
    );

    const rawEnv = {
      MEMPHIS_DATA_DIR: dir,
      MEMPHIS_VAULT_ENTRIES_PATH: entriesPath,
      MEMPHIS_VAULT_PEPPER: 'very-secure-pepper',
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
    } as NodeJS.ProcessEnv;

    saveVaultEntry(vaultEncrypt('DEMO_CONFIG_SECRET', 'secret-file-demo', rawEnv), rawEnv);

    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          id: 'demo-app',
          name: 'Demo App',
          description: 'demo app with vault-backed file materialization',
          actions: {
            install: {
              summary: 'write vault secret into a managed file',
              steps: [
                'test "$(cat "$APP_STATE_DIR/token.txt")" = "secret-file-demo" && printf file-ready',
              ],
              vaultFiles: {
                '${APP_STATE_DIR}/token.txt': {
                  key: 'DEMO_CONFIG_SECRET',
                  mode: '600',
                },
              },
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const ref = getManagedAppManifest({ file: manifestPath, rawEnv });
    const plan = planManagedAppAction(ref, 'install', { rawEnv });
    const secretFilePath = join(dir, 'apps', 'demo-app', 'state', 'token.txt');

    expect(plan.ok).toBe(true);
    expect(plan.secretBindings).toEqual([
      expect.objectContaining({
        target: 'file',
        path: secretFilePath,
        source: 'vault',
        status: 'pass',
        ok: true,
        vaultKey: 'DEMO_CONFIG_SECRET',
      }),
    ]);
    expect(plan.requirements.find((item) => item.id === `secret-file:${secretFilePath}`)?.ok).toBe(
      true,
    );

    const result = executeManagedAppAction(ref, 'install', { rawEnv, apply: true });

    expect(result.executed).toBe(true);
    expect(result.results[0]?.stdout).toContain('file-ready');
    expect(readFileSync(secretFilePath, 'utf8')).toBe('secret-file-demo');
  });
});

describe('validateManagedAppManifestFile', () => {
  it('returns ok:true for a valid manifest file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-validate-ok-'));
    const manifestPath = join(dir, 'demo.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        id: 'demo-app',
        name: 'Demo App',
        description: 'demo app for validate tests',
        capabilities: ['workspace'],
        actions: { install: { summary: 'install demo', steps: ['printf ok'] } },
      }),
      'utf8',
    );

    const result = validateManagedAppManifestFile(manifestPath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ref.manifest.id).toBe('demo-app');
      expect(result.ref.source.kind).toBe('file');
    }
  });

  it('returns ok:false with an error for a malformed manifest file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-validate-bad-'));
    const manifestPath = join(dir, 'bad.json');
    writeFileSync(manifestPath, '{"schemaVersion":1,"id":"bad"', 'utf8');

    const result = validateManagedAppManifestFile(manifestPath);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe(manifestPath);
      expect(result.error).toBeTruthy();
    }
  });

  it('returns ok:false for a manifest that fails schema validation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-validate-schema-'));
    const manifestPath = join(dir, 'invalid.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        id: 'Bad ID!',
        name: 'Bad',
        description: 'bad',
        actions: {},
      }),
      'utf8',
    );

    const result = validateManagedAppManifestFile(manifestPath);

    expect(result.ok).toBe(false);
  });
});

describe('importManagedAppManifestFile', () => {
  it('copies a valid manifest into the managed manifests directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-import-ok-'));
    const srcPath = join(dir, 'demo.json');
    writeFileSync(
      srcPath,
      JSON.stringify({
        schemaVersion: 1,
        id: 'demo-app',
        name: 'Demo App',
        description: 'demo app for import tests',
        actions: { install: { summary: 'install demo', steps: ['printf ok'] } },
      }),
      'utf8',
    );
    const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;

    const result = importManagedAppManifestFile(srcPath, { rawEnv });

    expect(result.ok).toBe(true);
    expect(result.id).toBe('demo-app');
    expect(result.dest).toContain('demo-app.json');
    expect(result.conflict).toBe(false);
    expect(result.overwritten).toBe(false);
    expect(JSON.parse(readFileSync(result.dest, 'utf8'))).toMatchObject({ id: 'demo-app' });
  });

  it('refuses to overwrite an existing manifest without --force', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-import-conflict-'));
    const manifestsDir = join(dir, 'apps', 'manifests');
    mkdirSync(manifestsDir, { recursive: true });
    const srcPath = join(dir, 'demo.json');
    const manifest = {
      schemaVersion: 1,
      id: 'demo-app',
      name: 'Demo App',
      description: 'demo app for conflict test',
      actions: { install: { summary: 'install demo', steps: ['printf ok'] } },
    };
    writeFileSync(srcPath, JSON.stringify(manifest), 'utf8');
    writeFileSync(join(manifestsDir, 'demo-app.json'), JSON.stringify(manifest), 'utf8');
    const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;

    const result = importManagedAppManifestFile(srcPath, { rawEnv });

    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.error).toContain('--force');
  });

  it('overwrites an existing manifest when --force is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-import-force-'));
    const manifestsDir = join(dir, 'apps', 'manifests');
    mkdirSync(manifestsDir, { recursive: true });
    const srcPath = join(dir, 'demo.json');
    const manifest = {
      schemaVersion: 1,
      id: 'demo-app',
      name: 'Demo App',
      description: 'demo app for force-overwrite test',
      actions: { install: { summary: 'install demo', steps: ['printf ok'] } },
    };
    writeFileSync(srcPath, JSON.stringify(manifest), 'utf8');
    writeFileSync(join(manifestsDir, 'demo-app.json'), '{}', 'utf8');
    const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;

    const result = importManagedAppManifestFile(srcPath, { force: true, rawEnv });

    expect(result.ok).toBe(true);
    expect(result.conflict).toBe(true);
    expect(result.overwritten).toBe(true);
  });

  it('returns ok:false when the source file is invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-import-bad-'));
    const srcPath = join(dir, 'bad.json');
    writeFileSync(srcPath, 'not json', 'utf8');
    const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;

    const result = importManagedAppManifestFile(srcPath, { rawEnv });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
