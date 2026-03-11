import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { appendBlock, verifyChainIntegrity } from '../../src/infra/storage/chain-adapter.js';
import { runCli } from '../helpers/cli.js';

const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe('security: chain integrity verification', () => {
  it('verifies linked prev_hash across blocks', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-chain-verify-'));
    process.env.HOME = home;

    await appendBlock(
      'journal',
      { type: 'journal', content: 'one' },
      { RUST_CHAIN_ENABLED: 'false' },
    );
    await appendBlock(
      'journal',
      { type: 'journal', content: 'two' },
      { RUST_CHAIN_ENABLED: 'false' },
    );

    const result = await verifyChainIntegrity('journal');
    expect(result.ok).toBe(true);
    expect(result.blockCount).toBe(2);
  });

  it('detects tampering when prev_hash link is broken', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-chain-verify-'));
    process.env.HOME = home;

    await appendBlock(
      'journal',
      { type: 'journal', content: 'one' },
      { RUST_CHAIN_ENABLED: 'false' },
    );
    await appendBlock(
      'journal',
      { type: 'journal', content: 'two' },
      { RUST_CHAIN_ENABLED: 'false' },
    );

    const chainDir = join(home, '.memphis', 'chains', 'journal');
    const secondPath = join(chainDir, '000002.json');
    const second = JSON.parse(readFileSync(secondPath, 'utf8')) as { prev_hash: string };
    second.prev_hash = 'f'.repeat(64);
    writeFileSync(secondPath, JSON.stringify(second, null, 2), 'utf8');

    await expect(verifyChainIntegrity('journal')).rejects.toThrow(/chain integrity check failed/);
  });

  it('exposes CLI command: memphis chain verify', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-chain-cli-'));
    process.env.HOME = home;
    await appendBlock(
      'journal',
      { type: 'journal', content: 'cli-check' },
      { RUST_CHAIN_ENABLED: 'false' },
    );

    const out = await runCli(['chain', 'verify', '--chain', 'journal', '--json'], {
      env: { HOME: home },
    });

    const parsed = JSON.parse(out) as { ok: boolean; chain?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.chain).toBe('journal');
  });
});
