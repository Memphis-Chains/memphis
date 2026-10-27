import { lstatSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { signCheckpoint, verifyCheckpoint, type UnsignedEnvelope } from './checkpoint.js';
import { fileHash, regularFile } from './installed.js';
import { isSessionAuthorized } from '../infra/auth/operator-gate.js';
import { writePrivateAtomicFile } from '../infra/config/private-atomic-file.js';
import { withVaultSecret } from '../security/vault-boundary.js';

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid unsigned checkpoint schema');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || fields.some((key) => !(key in record)))
    throw new Error('Invalid unsigned checkpoint fields');
  return record;
}

function validateUnsigned(value: unknown): UnsignedEnvelope {
  const v = object(value, [
    'version',
    'base_model',
    'onnx_sha256',
    'tokenizer_sha256',
    'heads_config',
    'training_provenance',
    'distribution_source',
  ]);
  const heads = object(v.heads_config, ['embedding_dim', 'zone_classes', 'multitask_alpha']);
  const provenance = object(v.training_provenance, [
    'trained_at',
    'corpus_version',
    'hardware',
    'eval_recall_at_10',
    'steps',
  ]);
  const unit = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  const text = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 2048;
  if (
    v.version !== 'kartograf-v1' ||
    typeof v.base_model !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/.test(v.base_model) ||
    ![v.onnx_sha256, v.tokenizer_sha256].every(
      (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s),
    ) ||
    heads.embedding_dim !== 256 ||
    heads.zone_classes !== 12 ||
    !unit(heads.multitask_alpha) ||
    !text(provenance.trained_at) ||
    !Number.isFinite(Date.parse(String(provenance.trained_at))) ||
    !text(provenance.corpus_version) ||
    !text(provenance.hardware) ||
    !unit(provenance.eval_recall_at_10) ||
    !Number.isSafeInteger(provenance.steps) ||
    Number(provenance.steps) <= 0 ||
    !['file', 'federation', 'hf-hub', 'github-release', 'agora'].includes(
      String(v.distribution_source),
    )
  )
    throw new Error('Invalid release checkpoint metadata; a pinned model revision is required');
  return v as UnsignedEnvelope;
}

/** Sign only public metadata; the private identity never leaves the vault callback. */
export async function signCheckpointBundle(source: string, env: NodeJS.ProcessEnv = process.env) {
  if (!isSessionAuthorized()) throw new Error('Operator authentication required');
  const input = resolve(source);
  regularFile(input, 1024 * 1024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(input, 'utf8'));
  } catch {
    throw new Error('Invalid unsigned checkpoint JSON');
  }
  const unsigned = validateUnsigned(parsed);
  const output = join(dirname(input), 'checkpoint.json');
  try {
    lstatSync(output);
    throw new Error('Checkpoint output already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const [name, expected, limit] of [
    ['model.onnx', unsigned.onnx_sha256, 2 * 1024 * 1024 * 1024],
    ['tokenizer.json', unsigned.tokenizer_sha256, 64 * 1024 * 1024],
  ] as const) {
    if ((await fileHash(join(dirname(input), name), limit)) !== expected)
      throw new Error('Checkpoint artifact hash mismatch');
  }
  const model = await open(join(dirname(input), 'model.onnx'), 'r');
  try {
    const prefix = Buffer.alloc(64);
    const { bytesRead } = await model.read(prefix, 0, prefix.length, 0);
    if (bytesRead === 0 || prefix.toString('utf8').startsWith('KARTOGRAF_STUB_ONNX'))
      throw new Error('Placeholder model cannot be released');
  } finally {
    await model.close();
  }
  // Stub/smoke artifacts are fixtures, never signed as release bundles.
  const tokenizer = join(dirname(input), 'tokenizer.json');
  let tokenizerValue: unknown;
  try {
    tokenizerValue = JSON.parse(readFileSync(tokenizer, 'utf8'));
  } catch {
    throw new Error('Invalid tokenizer JSON');
  }
  if (
    !tokenizerValue ||
    typeof tokenizerValue !== 'object' ||
    Array.isArray(tokenizerValue) ||
    'kartograf_stub_tokenizer' in tokenizerValue
  )
    throw new Error('Placeholder tokenizer cannot be released');
  const envelope = withVaultSecret(
    'did_seed',
    { surface: 'cli', command: 'kartograf sign' },
    (value) => {
      if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('Invalid vault identity');
      const seed = Buffer.from(value, 'hex');
      try {
        return signCheckpoint(unsigned, seed);
      } finally {
        seed.fill(0);
      }
    },
    env,
  );
  if (!verifyCheckpoint(envelope).valid) throw new Error('Produced signature is invalid');
  writePrivateAtomicFile(output, JSON.stringify(envelope, null, 2) + '\n', { exclusive: true });
  return { path: output, signerDid: envelope.signer_did, onnxSha256: envelope.onnx_sha256 };
}
