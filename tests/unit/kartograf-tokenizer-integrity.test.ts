import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AutoTokenizer } from '@huggingface/transformers';
import { InferenceSession } from 'onnxruntime-node';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: { from_pretrained: vi.fn() },
  env: {},
}));
vi.mock('onnxruntime-node', () => ({ InferenceSession: { create: vi.fn() }, Tensor: vi.fn() }));

import { sha256Hex, signCheckpoint } from '../../src/kartograf/checkpoint.js';
import { OnnxKartografSession } from '../../src/kartograf/onnx-session.js';

beforeEach(() => {
  vi.clearAllMocks();
});

it('refuses a changed tokenizer before native inference or local tokenizer configuration writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'memphis-tokenizer-integrity-'));
  const model = Buffer.from('synthetic graph bytes; native inference must not run');
  const envelope = signCheckpoint(
    {
      version: 'kartograf-v1',
      base_model: 'synthetic@revision',
      onnx_sha256: sha256Hex(model),
      tokenizer_sha256: sha256Hex('{"expected":true}'),
      heads_config: { embedding_dim: 256, zone_classes: 12, multitask_alpha: 0.7 },
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
  writeFileSync(join(directory, 'checkpoint.json'), JSON.stringify(envelope));
  writeFileSync(join(directory, 'model.onnx'), model);
  writeFileSync(join(directory, 'tokenizer.json'), '{"changed":true}');
  await expect(OnnxKartografSession.load(join(directory, 'checkpoint.json'))).rejects.toThrow(
    'tokenizer.json sha mismatch',
  );
  expect(InferenceSession.create).not.toHaveBeenCalled();
  expect(existsSync(join(directory, 'tokenizer_config.json'))).toBe(false);
});

it('releases an allocated native session when tokenizer initialization fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'memphis-tokenizer-release-'));
  const model = Buffer.from('synthetic graph bytes'),
    tokenizer = Buffer.from('{"synthetic":true}');
  const envelope = signCheckpoint(
    {
      version: 'kartograf-v1',
      base_model: 'synthetic@revision',
      onnx_sha256: sha256Hex(model),
      tokenizer_sha256: sha256Hex(tokenizer),
      heads_config: { embedding_dim: 256, zone_classes: 12, multitask_alpha: 0.7 },
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
  writeFileSync(join(directory, 'checkpoint.json'), JSON.stringify(envelope));
  writeFileSync(join(directory, 'model.onnx'), model);
  writeFileSync(join(directory, 'tokenizer.json'), tokenizer);
  const release = vi.fn(async () => {});
  vi.mocked(InferenceSession.create).mockResolvedValue({ release } as never);
  vi.mocked(AutoTokenizer.from_pretrained).mockRejectedValue(
    new Error('synthetic tokenizer failure'),
  );
  await expect(OnnxKartografSession.load(join(directory, 'checkpoint.json'))).rejects.toThrow(
    'synthetic tokenizer failure',
  );
  expect(release).toHaveBeenCalledOnce();
});
