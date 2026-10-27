import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/kartograf/session.js', () => ({ createKartografSession: vi.fn() }));

import { sha256Hex, signCheckpoint } from '../../src/kartograf/checkpoint.js';
import type { CheckpointEnvelope } from '../../src/kartograf/checkpoint.js';
import { embeddingSpaceFor } from '../../src/kartograf/embedding-space.js';
import {
  activateBundle,
  installBundle,
  installedBundles,
  selectedBundle,
} from '../../src/kartograf/installed.js';
import { createKartografSession } from '../../src/kartograf/session.js';

let root: string;
let source: string;
let env: NodeJS.ProcessEnv;
let did: string;
beforeEach(() => {
  vi.resetAllMocks();
  root = mkdtempSync(join(tmpdir(), 'memphis-kartograf-selection-'));
  source = join(root, 'producer');
  mkdirSync(source);
  env = {
    ...process.env,
    MEMPHIS_DATA_DIR: join(root, 'runtime'),
    MEMPHIS_HOME: join(root, 'runtime'),
  };
  const model = Buffer.from('synthetic fixture, not a deployable ONNX graph');
  const tokenizer = Buffer.from('{"synthetic":true}');
  const envelope = signCheckpoint(
    {
      version: 'kartograf-v1',
      base_model: 'synthetic@revision',
      onnx_sha256: sha256Hex(model),
      tokenizer_sha256: sha256Hex(tokenizer),
      heads_config: { embedding_dim: 2, zone_classes: 12, multitask_alpha: 0.7 },
      training_provenance: {
        trained_at: '2026-01-01T00:00:00Z',
        corpus_version: 'synthetic',
        hardware: 'test',
        eval_recall_at_10: 0.8,
        steps: 1,
      },
      distribution_source: 'file',
    },
    randomBytes(32),
  );
  did = envelope.signer_did;
  writeFileSync(join(source, 'checkpoint.json'), JSON.stringify(envelope));
  writeFileSync(join(source, 'model.onnx'), model);
  writeFileSync(join(source, 'tokenizer.json'), tokenizer);
});
const install = (dryRun = false) => installBundle(join(source, 'checkpoint.json'), env, dryRun);
const pointer = () => join(env.MEMPHIS_DATA_DIR!, 'kartograf', 'active.json');
function validEngine(envelope: CheckpointEnvelope) {
  const modelHash = envelope.onnx_sha256;
  const embeddingSpace = embeddingSpaceFor(envelope);
  return {
    checkpointId: modelHash,
    embeddingSpace,
    headsConfig: { embedding_dim: 2, zone_classes: 12, multitask_alpha: 0.7 },
    embed: vi.fn(async () => ({
      checkpointId: modelHash,
      embeddingSpaceId: embeddingSpace.id,
      embedding: new Float32Array([0.3, 0.4]),
      zones: [{ zone: 'patterns', score: 0.9 }],
    })),
    embedBatch: vi.fn(),
    close: vi.fn(async () => {}),
  };
}

it('previews without writes and publishes a complete private immutable bundle without implicitly selecting it', async () => {
  const preview = await install(true);
  expect(existsSync(env.MEMPHIS_DATA_DIR!)).toBe(false);
  const bundle = await install();
  expect(bundle.id).toBe(preview.id);
  expect((await installedBundles(env)).map((b) => b.id)).toEqual([bundle.id]);
  expect(await selectedBundle(env)).toBeNull();
  expect((await install()).id).toBe(bundle.id);
  for (const name of ['checkpoint.json', 'model.onnx', 'tokenizer.json'])
    expect(statSync(join(bundle.envelopePath, '..', name)).mode & 0o777).toBe(0o600);
});

it('requires a trusted signer and a successful real-session probe before atomic selection', async () => {
  const bundle = await install();
  await expect(
    activateBundle(bundle.id, 'did:key:ed25519:' + '00'.repeat(32), env),
  ).rejects.toThrow('not trusted');
  expect(createKartografSession).not.toHaveBeenCalled();
  const engine = validEngine(bundle.envelope);
  vi.mocked(createKartografSession).mockResolvedValue(engine);
  await activateBundle(bundle.id, did, env, true);
  expect(createKartografSession).not.toHaveBeenCalled();
  expect(existsSync(pointer())).toBe(false);
  await activateBundle(bundle.id, did, env);
  expect(engine.embed).toHaveBeenCalledOnce();
  expect(engine.close).toHaveBeenCalledOnce();
  expect((await selectedBundle(env))?.id).toBe(bundle.id);
  expect(statSync(pointer()).mode & 0o777).toBe(0o600);
});

it('refuses stub sessions, zero embeddings and corrupt artifacts without replacing the active selection', async () => {
  const bundle = await install();
  const engine = validEngine(bundle.envelope);
  vi.mocked(createKartografSession).mockResolvedValue(engine);
  await activateBundle(bundle.id, did, env);
  const before = readFileSync(pointer());
  vi.mocked(createKartografSession).mockResolvedValue({
    ...engine,
    checkpointId: 'stub:synthetic',
  });
  await expect(activateBundle(bundle.id, did, env)).rejects.toThrow('real ONNX');
  expect(readFileSync(pointer())).toEqual(before);
  engine.embed.mockResolvedValue({
    checkpointId: bundle.envelope.onnx_sha256,
    embeddingSpaceId: embeddingSpaceFor(bundle.envelope).id,
    embedding: new Float32Array([0, 0]),
    zones: [{ zone: 'patterns', score: 0.9 }],
  });
  vi.mocked(createKartografSession).mockResolvedValue(engine);
  await expect(activateBundle(bundle.id, did, env)).rejects.toThrow('invalid inference');
  expect(readFileSync(pointer())).toEqual(before);
  writeFileSync(join(source, 'model.onnx'), 'corrupted replacement');
  await expect(install()).rejects.toThrow('sha256 mismatch');
  expect(readFileSync(pointer())).toEqual(before);
  expect((await selectedBundle(env))?.id).toBe(bundle.id);
});

it('fails closed for corrupted selected artifacts or a dangling selection symlink', async () => {
  const bundle = await install();
  vi.mocked(createKartografSession).mockResolvedValue(validEngine(bundle.envelope));
  await activateBundle(bundle.id, did, env);
  writeFileSync(join(bundle.envelopePath, '..', 'tokenizer.json'), 'changed');
  await expect(selectedBundle(env)).rejects.toThrow('failed integrity');
  const other = { ...env, MEMPHIS_DATA_DIR: join(root, 'other') };
  mkdirSync(join(other.MEMPHIS_DATA_DIR, 'kartograf'), { recursive: true });
  symlinkSync(join(root, 'missing'), join(other.MEMPHIS_DATA_DIR, 'kartograf', 'active.json'));
  await expect(selectedBundle(other)).rejects.toThrow('regular file');
});

it('keeps activation writes in the captured runtime if the caller mutates its environment during inference', async () => {
  const bundle = await install();
  const originalPointer = pointer();
  const engine = validEngine(bundle.envelope);
  engine.embed.mockImplementation(async () => {
    env.MEMPHIS_DATA_DIR = join(root, 'different-runtime');
    return {
      checkpointId: bundle.envelope.onnx_sha256,
      embeddingSpaceId: embeddingSpaceFor(bundle.envelope).id,
      embedding: new Float32Array([0.3, 0.4]),
      zones: [{ zone: 'patterns', score: 0.9 }],
    };
  });
  vi.mocked(createKartografSession).mockResolvedValue(engine);
  await activateBundle(bundle.id, did, env);
  expect(existsSync(originalPointer)).toBe(true);
  expect(existsSync(pointer())).toBe(false);
});
