import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { InferenceSession, Tensor } from 'onnxruntime-node';
import { afterEach, expect, it, vi } from 'vitest';

import { OnnxKartografSession } from '../../src/kartograf/onnx-session.js';
import { kartografBundleFixture } from '../helpers/kartograf-bundle.js';

afterEach(() => vi.restoreAllMocks());
function outputs() {
  return {
    embedding: new Tensor('float32', new Float32Array([0.6, 0.8]), [1, 2]),
    zone_logits: new Tensor('float32', new Float32Array(12), [1, 12]),
  };
}
it('uses the real verified tokenizer without reading or rewriting unsigned sidecars', async () => {
  const fixture = kartografBundleFixture();
  const sidecar = join(fixture.root, 'tokenizer_config.json');
  const untrusted = JSON.stringify({
    do_lowercase_and_remove_accent: true,
    remove_space: true,
    model_max_length: 1,
  });
  writeFileSync(sidecar, untrusted);
  const run = vi.fn(async (feeds: Record<string, Tensor>) => {
    expect(feeds.input_ids.type).toBe('int64');
    return outputs();
  });
  const release = vi.fn(async () => {});
  vi.spyOn(InferenceSession, 'create').mockResolvedValue({ run, release } as never);
  const session = await OnnxKartografSession.load(fixture.path);
  try {
    const output = await session.embed('Hello world!');
    const feeds = run.mock.calls[0][0] as Record<string, Tensor>;
    expect(Array.from(feeds.input_ids.data)).toEqual([1n, 4n, 5n, 6n, 2n]);
    expect(output.embeddingSpaceId).toBe(session.embeddingSpace.id);
    await session.embed('hello '.repeat(600));
    expect((run.mock.calls[1][0] as Record<string, Tensor>).input_ids.dims).toEqual([1, 512]);
    expect(readFileSync(sidecar, 'utf8')).toBe(untrusted);
    expect(existsSync(join(fixture.root, 'config.json'))).toBe(false);
  } finally {
    await session.close();
  }
  expect(release).toHaveBeenCalledOnce();
});

it('refuses truncated, oversized, transposed, wrongly typed and non-finite ONNX outputs', async () => {
  const fixture = kartografBundleFixture();
  const run = vi.fn(async (feeds: Record<string, Tensor>) => {
    expect(feeds.input_ids.type).toBe('int64');
    return outputs();
  });
  vi.spyOn(InferenceSession, 'create').mockResolvedValue({
    run,
    release: vi.fn(async () => {}),
  } as never);
  const session = await OnnxKartografSession.load(fixture.path);
  expect(existsSync(join(fixture.root, 'tokenizer_config.json'))).toBe(false);
  try {
    const bad = [
      new Tensor('float32', new Float32Array([1]), [1, 1]),
      new Tensor('float32', new Float32Array([1, 2, 3]), [1, 3]),
      new Tensor('float32', new Float32Array([1, 2]), [2, 1]),
      new Tensor('float64', new Float64Array([1, 2]), [1, 2]),
      new Tensor('float32', new Float32Array([Number.NaN, 1]), [1, 2]),
      new Tensor('float32', new Float32Array([0, 0]), [1, 2]),
    ];
    for (const embedding of bad) {
      run.mockResolvedValue({ ...outputs(), embedding } as never);
      await expect(session.embed('hello')).rejects.toThrow();
    }
    run.mockResolvedValue({
      ...outputs(),
      zone_logits: new Tensor('float32', new Float32Array(11), [1, 11]),
    });
    await expect(session.embed('hello')).rejects.toThrow('invalid ONNX output');
    run.mockResolvedValue({
      ...outputs(),
      zone_logits: new Tensor('float32', new Float32Array(12).fill(Number.NaN), [1, 12]),
    });
    await expect(session.embed('hello')).rejects.toThrow('invalid ONNX output');
    run.mockResolvedValue(outputs());
    expect((await session.embed('hello')).embedding).toEqual(new Float32Array([0.6, 0.8]));
  } finally {
    await session.close();
  }
});
