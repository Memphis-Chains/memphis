// Chain format compatibility test — writes blocks via the current writer
// and reads them back via the current verifier. Catches:
//   - Schema drift between writer and verifier (e.g. canonical-JSON change
//     that breaks hash continuity).
//   - Hash-algorithm change without migration.
//   - Cross-platform JSON serialisation differences (key ordering on macOS
//     vs. Linux, BOM handling).
//
// Used by .github/workflows/ci.yml across the cross-arch matrix
// (ubuntu-latest, ubuntu-24.04-arm, macos-latest) so an arm64 / M-chip
// regression that breaks chain reads is caught at PR-merge time, not on
// the operator's box six months later.
//
// To extend with true forward-compat coverage (v1.6 binary reads on a
// v3.0 build), add a fixture directory `tests/fixtures/chain-v1.x/` with
// frozen JSON files and a parallel test that points MEMPHIS_DATA_DIR at
// the fixture and asserts verifyChainIntegrity passes.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendBlock, verifyChainIntegrity } from '../../src/infra/storage/chain-adapter.js';

describe('chain format round-trip (write → verify)', () => {
  let dataDir: string;
  let prevDataDir: string | undefined;
  let prevRustChainEnabled: string | undefined;
  let prevAllowAuditWrite: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memphis-chain-compat-'));
    mkdirSync(join(dataDir, 'chains', 'journal'), { recursive: true });
    mkdirSync(join(dataDir, 'chains', 'system'), { recursive: true });
    prevDataDir = process.env.MEMPHIS_DATA_DIR;
    prevRustChainEnabled = process.env.RUST_CHAIN_ENABLED;
    prevAllowAuditWrite = process.env.MEMPHIS_TEST_ALLOW_AUDIT_WRITE;
    process.env.MEMPHIS_DATA_DIR = dataDir;
    // Force pure-TS adapter so the test runs on platforms without the
    // Rust .node binary (arm64 macOS GitHub runner without rebuilt addon).
    process.env.RUST_CHAIN_ENABLED = 'false';
    // Block 1853 incident (2026-05-12): writes to the `system` chain
    // require explicit opt-in under VITEST so unit tests can't pollute
    // the operator's live chain. This integration test legitimately
    // exercises the system-chain write path under a tmpdir, so opt in.
    process.env.MEMPHIS_TEST_ALLOW_AUDIT_WRITE = '1';
  });

  afterEach(() => {
    if (prevDataDir !== undefined) process.env.MEMPHIS_DATA_DIR = prevDataDir;
    else delete process.env.MEMPHIS_DATA_DIR;
    if (prevRustChainEnabled !== undefined) process.env.RUST_CHAIN_ENABLED = prevRustChainEnabled;
    else delete process.env.RUST_CHAIN_ENABLED;
    if (prevAllowAuditWrite !== undefined)
      process.env.MEMPHIS_TEST_ALLOW_AUDIT_WRITE = prevAllowAuditWrite;
    else delete process.env.MEMPHIS_TEST_ALLOW_AUDIT_WRITE;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes 3 journal blocks and verifies the hash chain', async () => {
    await appendBlock('journal', {
      type: 'journal',
      content: 'first entry',
      tags: ['compat-test'],
      schemaVersion: 1,
    });
    await appendBlock('journal', {
      type: 'journal',
      content: 'second entry',
      tags: ['compat-test'],
      schemaVersion: 1,
    });
    await appendBlock('journal', {
      type: 'journal',
      content: 'third entry',
      tags: ['compat-test'],
      schemaVersion: 1,
    });

    const result = await verifyChainIntegrity('journal');
    expect(result.ok).toBe(true);
    expect(result.blockCount).toBe(3);
  });

  it('verifies multi-chain integrity in one pass', async () => {
    await appendBlock('journal', {
      type: 'journal',
      content: 'journal entry',
      schemaVersion: 1,
    });
    await appendBlock('system', {
      type: 'system_event',
      source: 'compat-test',
      content: 'system entry',
      schemaVersion: 1,
    });

    const all = await verifyChainIntegrity();
    expect(all.ok).toBe(true);
    expect(all.chainsChecked).toBeGreaterThanOrEqual(2);
    expect(all.blockCount).toBeGreaterThanOrEqual(2);
  });

  it('handles empty chain directory without throwing', async () => {
    // Fresh tmpdir created above with empty chains/journal — no blocks.
    const result = await verifyChainIntegrity('journal');
    expect(result.ok).toBe(true);
    expect(result.blockCount).toBe(0);
  });
});
