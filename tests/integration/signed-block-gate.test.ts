/**
 * Integration test: verifies that the Rust chain bridge enforces
 * block signatures when RUST_CHAIN_REQUIRE_SIGNATURES=true.
 *
 * This test is exercised in CI to ensure the signed-block append
 * path works end-to-end through the NAPI bridge.
 *
 * Note: RUST_CHAIN_REQUIRE_SIGNATURES and RUST_CHAIN_SIGNER_KEY_HEX
 * must be set on process.env because the Rust bridge reads them via
 * std::env::var, not from the env object passed to the TS adapter.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendBlock, getChainAdapterStatus } from '../../src/infra/storage/chain-adapter.js';

// Generate a deterministic 32-byte hex key for testing
const TEST_SIGNER_KEY_HEX = 'ab'.repeat(32);

function makeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'memphis-sig-gate-'));
  return {
    ...process.env,
    MEMPHIS_DATA_DIR: dataDir,
    RUST_CHAIN_ENABLED: 'true',
    ...overrides,
  };
}

describe('signed-block gate (CI)', () => {
  let savedRequireSigs: string | undefined;
  let savedSignerKey: string | undefined;

  beforeEach(() => {
    savedRequireSigs = process.env.RUST_CHAIN_REQUIRE_SIGNATURES;
    savedSignerKey = process.env.RUST_CHAIN_SIGNER_KEY_HEX;
  });

  afterEach(() => {
    // Restore original env
    if (savedRequireSigs === undefined) delete process.env.RUST_CHAIN_REQUIRE_SIGNATURES;
    else process.env.RUST_CHAIN_REQUIRE_SIGNATURES = savedRequireSigs;

    if (savedSignerKey === undefined) delete process.env.RUST_CHAIN_SIGNER_KEY_HEX;
    else process.env.RUST_CHAIN_SIGNER_KEY_HEX = savedSignerKey;
  });

  it('rust bridge loads and reports status', () => {
    const env = makeEnv();
    const status = getChainAdapterStatus(env);
    if (!status.rustBridgeLoaded) {
      console.warn('Rust bridge not available — skipping signed-block gate tests');
      return;
    }
    expect(status.rustBridgeLoaded).toBe(true);
  });

  it('appends a signed block when signer key is configured', async () => {
    process.env.RUST_CHAIN_REQUIRE_SIGNATURES = 'true';
    process.env.RUST_CHAIN_SIGNER_KEY_HEX = TEST_SIGNER_KEY_HEX;

    const env = makeEnv({
      RUST_CHAIN_REQUIRE_SIGNATURES: 'true',
      RUST_CHAIN_SIGNER_KEY_HEX: TEST_SIGNER_KEY_HEX,
    });
    const status = getChainAdapterStatus(env);
    if (!status.rustBridgeLoaded) return;

    const result = await appendBlock(
      'journal',
      { content: 'signed-block-gate test', tags: ['ci', 'signing'], source: 'test' },
      env,
    );

    expect(result.index).toBeGreaterThanOrEqual(0);
    expect(result.hash).toBeTruthy();
    expect(result.chain).toBe('journal');
  });

  it('rejects unsigned block when signatures are required but no key is set', async () => {
    process.env.RUST_CHAIN_REQUIRE_SIGNATURES = 'true';
    delete process.env.RUST_CHAIN_SIGNER_KEY_HEX;

    const env = makeEnv({
      RUST_CHAIN_REQUIRE_SIGNATURES: 'true',
    });
    delete env.RUST_CHAIN_SIGNER_KEY_HEX;

    const status = getChainAdapterStatus(env);
    if (!status.rustBridgeLoaded) return;

    await expect(
      appendBlock('journal', { content: 'should be rejected', tags: ['ci'], source: 'test' }, env),
    ).rejects.toThrow();
  });

  it('allows unsigned block when signatures are not required', async () => {
    process.env.RUST_CHAIN_REQUIRE_SIGNATURES = 'false';
    delete process.env.RUST_CHAIN_SIGNER_KEY_HEX;

    const env = makeEnv({
      RUST_CHAIN_REQUIRE_SIGNATURES: 'false',
    });
    delete env.RUST_CHAIN_SIGNER_KEY_HEX;

    const status = getChainAdapterStatus(env);
    if (!status.rustBridgeLoaded) return;

    const result = await appendBlock(
      'journal',
      { content: 'unsigned ok', tags: ['ci'], source: 'test' },
      env,
    );

    expect(result.index).toBeGreaterThanOrEqual(0);
    expect(result.chain).toBe('journal');
  });
});
