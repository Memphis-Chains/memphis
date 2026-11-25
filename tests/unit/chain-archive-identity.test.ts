/**
 * The chain IDENTITY gate and the repair that restores it.
 *
 * The case this file holds is the one the host was measured on
 * (2026-11-25): an archive directory — a ROLLBACK COPY of a chain — whose
 * blocks carry the archive's own DIRECTORY name instead of the chain's
 * logical name. Because the identity is inside the hash, such a copy is
 * self-consistent: every hash check passes, `chain verify` answers
 * `ok: true`, and the copy is a DIFFERENT history of the same blocks — one
 * that no longer seams with the rotation archive holding the blocks after
 * it, so it cannot be rolled back.
 *
 * The artefact is one directory per case (a live chain and a forked
 * archive of it), and the two runners are the API and the CLI.
 */

import * as crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  expectedChainIdentity,
  hashBlock,
  repairArchiveIdentity,
  verifyChainIntegrity,
} from '../../src/infra/storage/chain-adapter.js';
import { runCliResult } from '../helpers/cli.js';

const ARCHIVE = 'demo.backup-1700000000000';
const CHAIN = 'demo';
const GENESIS = '0'.repeat(64);

interface TestEnv {
  dataDir: string;
  chainsDir: string;
  prevEnv: NodeJS.ProcessEnv;
}

function setupEnv(): TestEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'memphis-archive-identity-'));
  const prevEnv = { ...process.env };
  process.env.MEMPHIS_DATA_DIR = dataDir;
  process.env.RUST_CHAIN_ENABLED = 'false';
  delete process.env.MEMPHIS_CHAIN_REPAIR_ON_MISMATCH;
  delete process.env.MEMPHIS_CHAINS_ALLOWLIST;
  const chainsDir = join(dataDir, 'chains');
  mkdirSync(chainsDir, { recursive: true });
  return { dataDir, chainsDir, prevEnv };
}

function tearDown(env: TestEnv): void {
  rmSync(env.dataDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in env.prevEnv)) delete process.env[key];
  }
  Object.assign(process.env, env.prevEnv);
}

/**
 * Write a chain's blocks under `dir`, carrying `identity` and hashed over
 * it — the same shape the host's rotation archive holds.
 */
function writeChain(dir: string, identity: string, count: number): void {
  mkdirSync(dir, { recursive: true });
  let prevHash = GENESIS;
  for (let index = 1; index <= count; index += 1) {
    const withoutHash = {
      index,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      chain: identity,
      data: { type: 'journal', content: `block-${index}`, tags: [] },
      prev_hash: prevHash,
    };
    const block = { ...withoutHash, hash: hashBlock(withoutHash, crypto) };
    writeFileSync(
      join(dir, `${String(index).padStart(6, '0')}.json`),
      `${JSON.stringify(block, null, 2)}\n`,
      'utf8',
    );
    prevHash = block.hash;
  }
}

describe('chain identity — an archive carries the chain, not its directory name', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    tearDown(env);
  });

  it('names the identity of a live chain and of an archive of it', () => {
    expect(expectedChainIdentity(CHAIN)).toBe(CHAIN);
    expect(expectedChainIdentity(ARCHIVE)).toBe(CHAIN);
    expect(expectedChainIdentity('case')).toBe('cases');
  });

  it('fails the verification of a copy that carries the wrong identity', async () => {
    writeChain(join(env.chainsDir, CHAIN), CHAIN, 3);
    writeChain(join(env.chainsDir, ARCHIVE), ARCHIVE, 3);

    // The live chain is untouched by the fork and still verifies.
    await expect(verifyChainIntegrity(CHAIN)).resolves.toMatchObject({ ok: true });

    // The archive's hashes are self-consistent — the identity is inside
    // them, so the hash check cannot see the fork. The identity check can.
    await expect(verifyChainIntegrity(ARCHIVE)).rejects.toThrow(/chain field/);
    await expect(verifyChainIntegrity(ARCHIVE)).rejects.toThrow(
      new RegExp(`chain field '${ARCHIVE}' ≠ expected '${CHAIN}'`),
    );
  });

  it('restores the copy and makes it a copy again', async () => {
    const liveDir = join(env.chainsDir, CHAIN);
    const archiveDir = join(env.chainsDir, ARCHIVE);
    writeChain(liveDir, CHAIN, 3);
    writeChain(archiveDir, ARCHIVE, 3);

    const liveBlocks = [1, 2, 3].map((index) =>
      JSON.parse(readFileSync(join(liveDir, `${String(index).padStart(6, '0')}.json`), 'utf8')),
    ) as { hash: string }[];

    const result = await repairArchiveIdentity(ARCHIVE);

    expect(result.blocksProcessed).toBe(3);
    expect(result.blocksRewritten).toBe(3);
    expect(result.chain).toBe(CHAIN);
    expect(result.backupPath).not.toBeNull();

    // The copy now carries the chain's identity and hashes over it — which
    // is the live chain's hash, block for block. The seam holds again.
    const repairedBlocks = [1, 2, 3].map((index) =>
      JSON.parse(readFileSync(join(archiveDir, `${String(index).padStart(6, '0')}.json`), 'utf8')),
    ) as { chain: string; hash: string }[];
    expect(repairedBlocks.map((block) => block.chain)).toEqual([CHAIN, CHAIN, CHAIN]);
    expect(repairedBlocks.map((block) => block.hash)).toEqual(
      liveBlocks.map((block) => block.hash),
    );

    await expect(verifyChainIntegrity(ARCHIVE)).resolves.toMatchObject({ ok: true });
  });

  it('refuses a live chain — its identity is its own name', async () => {
    writeChain(join(env.chainsDir, CHAIN), CHAIN, 3);
    await expect(repairArchiveIdentity(CHAIN)).rejects.toThrow(/is not an archive directory/);
  });

  it('repairs through the CLI as well', async () => {
    writeChain(join(env.chainsDir, CHAIN), CHAIN, 2);
    writeChain(join(env.chainsDir, ARCHIVE), ARCHIVE, 2);

    const failed = await runCliResult(['chain', 'verify', '--chain', ARCHIVE]);
    expect(failed.status).not.toBe(0);
    expect(`${failed.stdout}${failed.stderr}`).toContain('chain field');

    const repaired = await runCliResult([
      'chain',
      'repair-archive-identity',
      '--chain',
      ARCHIVE,
      '--json',
    ]);
    expect(repaired.status).toBe(0);
    expect(repaired.stdout).toContain('"blocksRewritten": 2');

    const verified = await runCliResult(['chain', 'verify', '--chain', ARCHIVE]);
    expect(verified.status).toBe(0);
  });
});
