import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendBlock, getChainAdapterStatus, resolveChainDir } from '../../src/infra/storage/chain-adapter.js';

const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe('chain adapter feature flag', () => {
  it('defaults to ts-legacy when rust flag is off', () => {
    const out = getChainAdapterStatus({
      RUST_CHAIN_ENABLED: 'false',
    } as NodeJS.ProcessEnv);

    expect(out.backend).toBe('ts-legacy');
    expect(out.rustEnabled).toBe(false);
    expect(out.rustBridgeLoaded).toBe(false);
  });

  it('falls back to ts-legacy when rust flag is on but bridge path is unavailable', () => {
    const out = getChainAdapterStatus({
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: '/tmp/definitely-missing-bridge.node',
    } as NodeJS.ProcessEnv);

    expect(out.backend).toBe('ts-legacy');
    expect(out.rustEnabled).toBe(true);
    expect(out.rustBridgeLoaded).toBe(false);
  });

  it('rejects unsafe chain names when resolving storage path', () => {
    expect(() =>
      resolveChainDir('../../tmp/pwn', {
        homedir: '/home/test',
        resolve: (...parts) => join(...parts),
        sep: '/',
      }),
    ).toThrow(/invalid chain name/);

    expect(() =>
      resolveChainDir('journal\u0000evil', {
        homedir: '/home/test',
        resolve: (...parts) => join(...parts),
        sep: '/',
      }),
    ).toThrow(/invalid chain name/);
  });

  it('links prev_hash to the previous full block hash', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-chain-home-'));
    process.env.HOME = home;

    const first = await appendBlock('journal', { type: 'journal', content: 'one' }, { RUST_CHAIN_ENABLED: 'false' });
    const second = await appendBlock('journal', { content: 'two', type: 'journal' }, { RUST_CHAIN_ENABLED: 'false' });

    const chainDir = join(home, '.memphis', 'chains', 'journal');
    const firstBlock = JSON.parse(readFileSync(join(chainDir, '000001.json'), 'utf8')) as { hash: string; prev_hash: string };
    const secondBlock = JSON.parse(readFileSync(join(chainDir, '000002.json'), 'utf8')) as { hash: string; prev_hash: string };

    expect(first.index).toBe(1);
    expect(firstBlock.prev_hash).toBe('0'.repeat(64));
    expect(second.index).toBe(2);
    expect(secondBlock.prev_hash).toBe(firstBlock.hash);
    expect(second.hash).toBe(secondBlock.hash);
  });

  it('refuses append when an existing block has been tampered with', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-chain-home-'));
    process.env.HOME = home;

    await appendBlock('journal', { type: 'journal', content: 'one' }, { RUST_CHAIN_ENABLED: 'false' });
    const chainDir = join(home, '.memphis', 'chains', 'journal');
    const firstPath = join(chainDir, '000001.json');
    const tampered = JSON.parse(readFileSync(firstPath, 'utf8')) as { data: { content: string } };
    tampered.data.content = 'tampered';
    writeFileSync(firstPath, JSON.stringify(tampered, null, 2), 'utf8');

    await expect(
      appendBlock('journal', { type: 'journal', content: 'two' }, { RUST_CHAIN_ENABLED: 'false' }),
    ).rejects.toThrow(/chain integrity check failed/);
  });

  it('accepts legacy blocks and links new block to their full stored hash', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-chain-home-'));
    process.env.HOME = home;
    const chainDir = join(home, '.memphis', 'chains', 'journal');
    const crypto = await import('node:crypto');
    const fs = await import('node:fs/promises');

    await fs.mkdir(chainDir, { recursive: true });
    const legacyData = { type: 'journal', content: 'legacy' };
    const legacyBlock = {
      index: 1,
      timestamp: new Date().toISOString(),
      chain: 'journal',
      data: legacyData,
      prev_hash: '',
      hash: crypto.createHash('sha256').update(JSON.stringify(legacyData)).digest('hex'),
    };
    await fs.writeFile(join(chainDir, '000001.json'), JSON.stringify(legacyBlock, null, 2), 'utf8');

    const appended = await appendBlock('journal', { type: 'journal', content: 'new' }, { RUST_CHAIN_ENABLED: 'false' });
    const second = JSON.parse(readFileSync(join(chainDir, '000002.json'), 'utf8')) as { prev_hash: string };

    expect(appended.index).toBe(2);
    expect(second.prev_hash).toBe(legacyBlock.hash);
  });
});
