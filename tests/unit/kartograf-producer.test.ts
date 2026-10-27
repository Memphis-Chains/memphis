import { randomBytes } from 'node:crypto';
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

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({ authorized: true, vault: vi.fn() }));
vi.mock('../../src/infra/auth/operator-gate.js', () => ({
  isSessionAuthorized: () => deps.authorized,
  requireOperatorAuth: async () => deps.authorized,
}));
vi.mock('../../src/security/vault-boundary.js', () => ({ withVaultSecret: deps.vault }));

import type { CliContext } from '../../src/infra/cli/context.js';
import { kartografCommandHandler } from '../../src/infra/cli/handlers/kartograf.handler.js';
import { sha256Hex, verifyCheckpoint } from '../../src/kartograf/checkpoint.js';
import { signCheckpointBundle } from '../../src/kartograf/producer.js';

const oldExit = process.exitCode;
beforeEach(() => {
  deps.authorized = true;
  deps.vault
    .mockReset()
    .mockImplementation((_key, _context, use) => use(randomBytes(32).toString('hex')));
});
afterEach(() => {
  process.exitCode = oldExit;
  vi.restoreAllMocks();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'memphis-producer-'));
  const model = Buffer.from('synthetic model bytes; this test does not prove ONNX inference');
  const tokenizer = '{}';
  writeFileSync(join(root, 'model.onnx'), model);
  writeFileSync(join(root, 'tokenizer.json'), tokenizer);
  const metadata = {
    version: 'kartograf-v1',
    base_model: `example/model@${'a'.repeat(40)}`,
    onnx_sha256: sha256Hex(model),
    tokenizer_sha256: sha256Hex(tokenizer),
    heads_config: { embedding_dim: 256, zone_classes: 12, multitask_alpha: 0.7 },
    training_provenance: {
      trained_at: '2026-10-27T10:00:00Z',
      corpus_version: 'test',
      hardware: 'synthetic',
      eval_recall_at_10: 0.5,
      steps: 1,
    },
    distribution_source: 'file',
  };
  const file = join(root, 'unsigned-checkpoint.json');
  writeFileSync(file, JSON.stringify(metadata));
  return { root, file, metadata };
}

it('signs verified metadata using bounded vault access and publishes privately without replacement', async () => {
  const { file, metadata } = fixture();
  const result = await signCheckpointBundle(file, {});
  const signed = JSON.parse(readFileSync(result.path, 'utf8'));
  expect(verifyCheckpoint(signed).valid).toBe(true);
  expect(signed).toMatchObject(metadata);
  expect(statSync(result.path).mode & 0o777).toBe(0o600);
  expect(deps.vault).toHaveBeenCalledWith(
    'did_seed',
    { surface: 'cli', command: 'kartograf sign' },
    expect.any(Function),
    {},
  );
  const previous = readFileSync(result.path);
  deps.vault.mockClear();
  await expect(signCheckpointBundle(file)).rejects.toThrow('already exists');
  expect(deps.vault).not.toHaveBeenCalled();
  expect(readFileSync(result.path)).toEqual(previous);
});

it('refuses unauthorized access before touching files or the vault', async () => {
  deps.authorized = false;
  await expect(signCheckpointBundle('/nonexistent/private-file')).rejects.toThrow('authentication');
  expect(deps.vault).not.toHaveBeenCalled();
});

it('refuses corrupt artifacts, symlinks, unknown metadata and placeholder releases before vault access', async () => {
  for (const change of [
    'hash',
    'symlink',
    'output-symlink',
    'unknown',
    'stub',
    'stub-tokenizer',
    'revision',
    'numeric',
  ] as const) {
    const { file, root, metadata } = fixture();
    if (change === 'hash') writeFileSync(join(root, 'model.onnx'), 'changed');
    if (change === 'symlink') {
      symlinkSync(file, join(root, 'link.json'));
      await expect(signCheckpointBundle(join(root, 'link.json'))).rejects.toThrow();
      continue;
    }
    if (change === 'unknown') Object.assign(metadata, { secret: 'synthetic-private-sentinel' });
    if (change === 'output-symlink')
      symlinkSync(join(root, 'absent.json'), join(root, 'checkpoint.json'));
    if (change === 'stub-tokenizer') {
      const bytes = JSON.stringify({ kartograf_stub_tokenizer: true });
      writeFileSync(join(root, 'tokenizer.json'), bytes);
      metadata.tokenizer_sha256 = sha256Hex(bytes);
    }
    if (change === 'revision') metadata.base_model = 'example/model@main';
    if (change === 'numeric')
      metadata.training_provenance.eval_recall_at_10 = Number.POSITIVE_INFINITY;
    if (change === 'stub') {
      writeFileSync(join(root, 'model.onnx'), 'KARTOGRAF_STUB_ONNX_v1');
      metadata.onnx_sha256 = sha256Hex('KARTOGRAF_STUB_ONNX_v1');
    }
    writeFileSync(file, JSON.stringify(metadata));
    await expect(signCheckpointBundle(file)).rejects.toThrow();
    expect(existsSync(join(root, 'checkpoint.json'))).toBe(false);
  }
  expect(deps.vault).not.toHaveBeenCalled();
});

it('does not expose underlying vault diagnostics through the CLI or publish a failed signature', async () => {
  const { file, root } = fixture();
  deps.vault.mockImplementation(() => {
    throw new Error('synthetic-private-sentinel');
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(
    await kartografCommandHandler.handle({
      args: { command: 'kartograf', subcommand: 'sign', file, json: true },
    } as CliContext),
  ).toBe(true);
  expect(process.exitCode).toBe(2);
  expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private-sentinel');
  expect(JSON.parse(String(log.mock.calls[0][0])).ok).toBe(false);
  expect(existsSync(join(root, 'checkpoint.json'))).toBe(false);
});
