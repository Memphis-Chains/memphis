import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appendBlock } from '../../src/infra/storage/chain-adapter.js';
import { runMemphisChainVerify } from '../../src/mcp/tools/chain-verify.js';

describe('memphis_chain_verify', () => {
  it('returns authoritative verification metadata for a selected chain', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-chain-verify-tool-'));
    const rawEnv = {
      ...process.env,
      MEMPHIS_DATA_DIR: dataDir,
      RUST_CHAIN_ENABLED: 'false',
      RUST_CHAIN_REQUIRE_SIGNATURES: 'false',
    };
    await appendBlock('journal', { content: 'verified block', tags: ['test'] }, rawEnv);

    const result = await runMemphisChainVerify({ chain: 'journal' }, rawEnv);

    expect(result).toMatchObject({
      ok: true,
      chainsChecked: 1,
      blockCount: 1,
      chain: 'journal',
    });
    expect(Date.parse(result.verifiedAt)).not.toBeNaN();
  });

  it('returns a structured failure instead of forcing the model to infer corruption', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-chain-verify-failure-'));
    const journalDir = join(dataDir, 'chains', 'journal');
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(join(journalDir, '000001.json'), '{not-json');

    const result = await runMemphisChainVerify(
      { chain: 'journal' },
      {
        ...process.env,
        MEMPHIS_DATA_DIR: dataDir,
        RUST_CHAIN_ENABLED: 'false',
        RUST_CHAIN_REQUIRE_SIGNATURES: 'false',
      },
    );

    expect(result).toMatchObject({
      ok: false,
      chainsChecked: 0,
      blockCount: 0,
      chain: 'journal',
    });
    expect(result.error).toContain('chain integrity check failed');
  });
});
