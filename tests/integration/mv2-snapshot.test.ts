import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/security/vault-boundary.js', () => ({
  withVaultSecret: (_key: string, _context: unknown, callback: (value: string) => unknown) =>
    callback('31'.repeat(32)),
}));

import {
  appendBlock,
  exportChain,
  validateChainSnapshot,
} from '../../src/infra/storage/chain-adapter.js';
import {
  exportMv2Snapshot,
  inspectMv2Snapshot,
  previewMv2Restore,
  restoreMv2Snapshot,
} from '../../src/infra/storage/mv2-snapshot.js';

const chains = ['journal', 'decisions', 'patterns', 'reflections', 'system', 'cases'];
const privateKey = createPrivateKey({
  key: Buffer.from('302e020100300506032b657004220420' + '31'.repeat(32), 'hex'),
  format: 'der',
  type: 'pkcs8',
});
const signer = createPublicKey(privateKey)
  .export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('hex');
const did = 'did:key:ed25519:' + signer;
let root: string;
let env: NodeJS.ProcessEnv;
let file: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'memphis-mv2-roundtrip-'));
  env = {
    ...process.env,
    MEMPHIS_HOME: join(root, 'source'),
    MEMPHIS_DATA_DIR: join(root, 'source'),
    RUST_CHAIN_ENABLED: 'false',
    RUST_CHAIN_REQUIRE_SIGNATURES: 'false',
    MEMPHIS_TEST_ALLOW_AUDIT_WRITE: '1',
  };
  file = join(root, 'snapshot.mv2');
  for (const name of chains) {
    await appendBlock(
      name,
      {
        type: 'journal',
        content: name + ' α',
        tags: ['roundtrip'],
        extra: { preserved: true, float: 0.000014112000805986721 },
      },
      env,
    );
    await appendBlock(name, { type: 'journal', content: name + ' second', tags: [] }, env);
  }
});

it('round-trips six chains with all payload fields and original hashes through the real native codec', async () => {
  const exported = await exportMv2Snapshot(file, chains.join(','), env);
  expect(exported.blockCount).toBe(12);
  expect(exported.manifest.signerDid).toBe(did);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const target = join(root, 'restored');
  const preview = await previewMv2Restore(file, target, env, did);
  expect(preview.blockCount).toBe(12);
  expect(existsSync(target)).toBe(false);
  await restoreMv2Snapshot(file, target, env, did);
  expect(statSync(target).mode & 0o777).toBe(0o700);
  for (const name of chains) {
    const original = (await exportChain(name, env)).blocks;
    const restored = (
      await exportChain(name, { ...env, MEMPHIS_HOME: target, MEMPHIS_DATA_DIR: target })
    ).blocks;
    expect(restored).toEqual(original);
    expect(restored[0].data.extra).toEqual({ preserved: true, float: 0.000014112000805986721 });
  }
});

it('requires an independently trusted signer before creating a destination', async () => {
  await exportMv2Snapshot(file, 'journal', env);
  await expect(restoreMv2Snapshot(file, join(root, 'restored'), env)).rejects.toThrow(
    'not trusted',
  );
  await expect(inspectMv2Snapshot(file, env, 'did:key:ed25519:' + '00'.repeat(32))).rejects.toThrow(
    'not trusted',
  );
  expect(existsSync(join(root, 'restored'))).toBe(false);
});

it('refuses container corruption and a payload alteration even with a recomputed native checksum', async () => {
  await exportMv2Snapshot(file, 'journal', env);
  const bytes = readFileSync(file);
  bytes[bytes.length - 1] ^= 1;
  const corrupt = join(root, 'corrupt.mv2');
  writeFileSync(corrupt, bytes);
  await expect(inspectMv2Snapshot(corrupt, env, did)).rejects.toThrow('native codec refused');
  const original = readFileSync(file);
  const textOffset = original.indexOf(Buffer.from('journal second'));
  expect(textOffset).toBeGreaterThan(44);
  original[textOffset] = 'J'.charCodeAt(0);
  createHash('sha256').update(original.subarray(44)).digest().copy(original, 8);
  writeFileSync(corrupt, original);
  await expect(inspectMv2Snapshot(corrupt, env, did)).rejects.toThrow(
    'signature or content digest',
  );
});

it('refuses overwrites, symlink destinations and destinations inside the active runtime in dry-run and write modes', async () => {
  await exportMv2Snapshot(file, 'journal', env);
  await expect(exportMv2Snapshot(file, 'journal', env)).rejects.toMatchObject({ code: 'EEXIST' });
  for (const target of [env.MEMPHIS_DATA_DIR!, join(env.MEMPHIS_DATA_DIR!, 'nested')]) {
    await expect(previewMv2Restore(file, target, env, did)).rejects.toThrow('active runtime');
    await expect(restoreMv2Snapshot(file, target, env, did)).rejects.toThrow('active runtime');
  }
  const target = join(root, 'linked');
  symlinkSync(join(root, 'missing'), target);
  await expect(previewMv2Restore(file, target, env, did)).rejects.toThrow('already exists');
  await expect(restoreMv2Snapshot(file, target, env, did)).rejects.toThrow('already exists');
});

it('rejects a second concurrent restore to the same destination', async () => {
  await exportMv2Snapshot(file, chains.join(','), env);
  const results = await Promise.allSettled([
    restoreMv2Snapshot(file, join(root, 'restore'), env, did),
    restoreMv2Snapshot(file, join(root, 'restore'), env, did),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
});

it('validates preserved block signatures and continuity independently of the snapshot signature', async () => {
  const blocks = (await exportChain('journal', env)).blocks;
  const signed = blocks.map((block) => ({
    ...block,
    signer,
    signature: sign(null, Buffer.from(block.hash), privateKey).toString('hex'),
    provenance: { retained: true },
  }));
  expect(validateChainSnapshot('journal', signed)).toEqual(signed);
  expect(() =>
    validateChainSnapshot('journal', [{ ...signed[0], signature: '00'.repeat(64) }]),
  ).toThrow('signature');
  expect(() => validateChainSnapshot('journal', [signed[1]])).toThrow('continuity');
  expect(() => validateChainSnapshot('journal', [{ ...signed[0], hash: '00'.repeat(32) }])).toThrow(
    'hash',
  );
});
