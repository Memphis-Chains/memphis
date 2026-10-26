import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '', seed: '11'.repeat(32) }));
vi.mock('../../src/config/paths.js', () => ({ getDataDir: () => state.root }));
vi.mock('../../src/security/vault-boundary.js', () => ({
  listVaultEntryMetadata: vi.fn(() => [{ key: 'did_seed' }]),
  storeVaultSecret: vi.fn(),
  withVaultSecret: vi.fn((_key, _context, callback) => callback(state.seed)),
}));
vi.mock('../../src/mcp/tools/journal.js', () => ({
  runMemphisJournal: vi.fn(async () => ({ success: true })),
}));
vi.mock('../../src/infra/cli/utils/render.js', () => ({ print: vi.fn() }));

import type { CliContext } from '../../src/infra/cli/context.js';
import { identityCommandHandler } from '../../src/infra/cli/handlers/identity.handler.js';
import { print } from '../../src/infra/cli/utils/render.js';
import {
  listVaultEntryMetadata,
  storeVaultSecret,
  withVaultSecret,
} from '../../src/security/vault-boundary.js';

const previousExit = process.exitCode;
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'memphis-did-recover-'));
  state.seed = '11'.repeat(32);
  vi.clearAllMocks();
  vi.mocked(withVaultSecret).mockImplementation((_key, _context, callback) => callback(state.seed));
  vi.mocked(listVaultEntryMetadata).mockReturnValue([{ key: 'did_seed' }] as never);
  process.exitCode = 0;
});
afterEach(() => {
  process.exitCode = previousExit;
});
const call = (subcommand: string, force = false) =>
  identityCommandHandler.handle({
    args: { command: 'identity', subcommand, json: true, force },
  } as CliContext);
const result = () => vi.mocked(print).mock.calls.at(-1)![0] as Record<string, unknown>;

it('recovers the public identity that verifies existing signatures without writing a seed', async () => {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(state.seed, 'hex'),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const message = Buffer.from('identity retained');
  const signature = sign(null, message, privateKey);
  await call('recover');
  const recovered = JSON.parse(readFileSync(join(state.root, 'did.json'), 'utf8'));
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(recovered.publicKeyHex, 'hex'),
    ]),
    format: 'der',
    type: 'spki',
  });
  expect(verify(null, message, publicKey, signature)).toBe(true);
  expect(recovered.did).toBe(`did:key:ed25519:${recovered.publicKeyHex}`);
  expect(statSync(join(state.root, 'did.json')).mode & 0o777).toBe(0o600);
  expect(result()).toMatchObject({ ok: true, recovered: true, rotated: false });
  expect(storeVaultSecret).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(print).mock.calls)).not.toContain(state.seed);
});

it('is idempotent and leaves the existing public file unchanged', async () => {
  await call('recover');
  const path = join(state.root, 'did.json');
  const before = { bytes: readFileSync(path), stat: statSync(path).mtimeMs };
  await call('recover');
  expect(readFileSync(path)).toEqual(before.bytes);
  expect(statSync(path).mtimeMs).toBe(before.stat);
  expect(result()).toMatchObject({ ok: true, recovered: false, alreadyPresent: true });
  expect(storeVaultSecret).not.toHaveBeenCalled();
});

it('refuses a conflicting public identity even with force', async () => {
  await call('recover');
  const before = readFileSync(join(state.root, 'did.json'));
  state.seed = '22'.repeat(32);
  await call('recover', true);
  expect(process.exitCode).toBe(1);
  expect(result().reason).toBe('identity-mismatch');
  expect(readFileSync(join(state.root, 'did.json'))).toEqual(before);
  expect(storeVaultSecret).not.toHaveBeenCalled();
});

it.each(['', 'not-a-seed', 'aa'.repeat(31)])(
  'refuses an invalid seed without creating a public file: %s',
  async (seed) => {
    state.seed = seed;
    await call('recover');
    expect(result()).toMatchObject({ ok: false, reason: 'seed-unavailable' });
    expect(existsSync(join(state.root, 'did.json'))).toBe(false);
    expect(storeVaultSecret).not.toHaveBeenCalled();
  },
);

it('does not echo a vault exception containing secret material', async () => {
  vi.mocked(withVaultSecret).mockImplementation(() => {
    throw new Error(state.seed);
  });
  await call('recover');
  expect(JSON.stringify(vi.mocked(print).mock.calls)).not.toContain(state.seed);
  expect(existsSync(join(state.root, 'did.json'))).toBe(false);
});

it('init requires recovery instead of replacing an existing vault seed', async () => {
  await call('init');
  expect(result()).toMatchObject({ ok: false, reason: 'recovery-required' });
  expect(process.exitCode).toBe(1);
  expect(storeVaultSecret).not.toHaveBeenCalled();
  expect(existsSync(join(state.root, 'did.json'))).toBe(false);
});

it('preserves a malformed existing public file', async () => {
  const path = join(state.root, 'did.json');
  writeFileSync(path, '{broken');
  await call('recover');
  expect(result().reason).toBe('invalid-public-file');
  expect(readFileSync(path, 'utf8')).toBe('{broken');
  await call('init');
  expect(result().reason).toBe('invalid-public-file');
  expect(storeVaultSecret).not.toHaveBeenCalled();
});

it('init refuses to generate a key when vault metadata is unreadable', async () => {
  vi.mocked(listVaultEntryMetadata).mockImplementation(() => {
    throw new Error('vault unavailable');
  });
  await call('init');
  expect(result().reason).toBe('vault-unreadable');
  expect(storeVaultSecret).not.toHaveBeenCalled();
});
