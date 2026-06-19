import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assessRustBridgeManifestStatus } from '../../src/infra/storage/rust-bridge-manifest.js';

function writeBridge(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'memphis-bridge-manifest-'));
  const bridgePath = join(dir, 'bridge.cjs');
  writeFileSync(bridgePath, contents, 'utf8');
  return bridgePath;
}

describe('assessRustBridgeManifestStatus', () => {
  it('warns when rust bridge is disabled outside strict mode', () => {
    const status = assessRustBridgeManifestStatus({
      RUST_CHAIN_ENABLED: 'false',
    } as NodeJS.ProcessEnv);

    expect(status.ok).toBe(true);
    expect(status.level).toBe('warn');
    expect(status.strictRequired).toBe(false);
  });

  it('fails when rust bridge is disabled in strict mode', () => {
    const status = assessRustBridgeManifestStatus({
      RUST_CHAIN_ENABLED: 'false',
      MEMPHIS_STRICT_RUST_BRIDGE: '1',
    } as NodeJS.ProcessEnv);

    expect(status.ok).toBe(false);
    expect(status.level).toBe('fail');
    expect(status.strictRequired).toBe(true);
  });

  it('fails when a loaded bridge has no manifest', () => {
    const bridgePath = writeBridge("module.exports = { chain_append: () => '{}' };\n");
    const status = assessRustBridgeManifestStatus({
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
    } as NodeJS.ProcessEnv);

    expect(status.ok).toBe(false);
    expect(status.bridgeLoaded).toBe(true);
    expect(status.manifestAvailable).toBe(false);
    expect(status.missingRequiredExports).toContain('bridge_manifest');
  });

  it('passes when manifest and required exports are present through canonical or legacy aliases', () => {
    const manifest = {
      ok: true,
      data: {
        name: 'test-bridge',
        schemaVersion: 1,
        exports: ['bridge_manifest', 'chain_append'],
        requiredExports: ['bridge_manifest', 'chain_append', 'paths_resolve_data_dir'],
      },
    };
    const bridgePath = writeBridge(`
      module.exports = {
        bridgeManifest: () => ${JSON.stringify(JSON.stringify(manifest))},
        chain_append: () => '{}',
        chain_validate: () => '{}',
        chain_query: () => '{}',
        vault_init_json: () => '{}',
        vault_init_full: () => ({}),
        vault_store: () => ({}),
        vault_retrieve: () => Buffer.from(''),
        embed_store: () => '{}',
        embed_store_many: () => '{}',
        embed_flush: () => '{}',
        embed_search: () => '{}',
        embed_search_tuned: () => '{}',
        embed_reset: () => '{}',
        embed_shutdown: () => '{}',
        soul_loop_step: () => '{}',
        soul_replay: () => '{}',
        case_append: () => '{}',
        case_query: () => '{}',
        case_rebuild: () => '{}',
        pathsResolveDataDir: () => '{}',
        pathsResolveVaultState: () => '{}',
        pathsResolveVaultEntries: () => '{}',
        pathsResolveChainsDir: () => '{}',
        pathsResolveChainPath: () => '{}',
        pathsResolveEmbedIndex: () => '{}',
        pathsResolveCaseIndex: () => '{}',
        pathsResolveDatabasePath: () => '{}',
        pathsNormalizeChainName: () => '{}',
      };
    `);

    const status = assessRustBridgeManifestStatus({
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
    } as NodeJS.ProcessEnv);

    expect(status.ok).toBe(true);
    expect(status.manifestAvailable).toBe(true);
    expect(status.legacyAliasesUsed).toMatchObject({
      bridge_manifest: 'bridgeManifest',
      paths_resolve_data_dir: 'pathsResolveDataDir',
    });
  });
});
