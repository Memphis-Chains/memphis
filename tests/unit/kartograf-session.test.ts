/**
 * Sprint 4.2 — verify the Kartograf TS session scaffold contract:
 *  - Factory returns a session implementing the interface
 *  - Stub session produces deterministic zero-embeddings of the
 *    declared dimension
 *  - close() is idempotent and gates further calls
 */

import { describe, expect, it } from 'vitest';

import {
  createKartografSession,
  type KartografSessionConfig,
} from '../../src/kartograf/session.js';

const baseConfig: KartografSessionConfig = {
  checkpointPath: 'kartograf/v1.onnx',
  headsConfig: {
    embedding_dim: 256,
    zone_classes: 12,
    multitask_alpha: 0.7,
  },
};

describe('createKartografSession (sprint 4.2 stub)', () => {
  it('returns a session with a deterministic checkpointId for stub mode', async () => {
    const session = await createKartografSession(baseConfig);
    expect(session.checkpointId).toBe('stub:kartograf/v1.onnx');
    expect(session.headsConfig.embedding_dim).toBe(256);
  });

  it('embed() returns a 256d zero vector + none zone', async () => {
    const session = await createKartografSession(baseConfig);
    const result = await session.embed('hello world');
    expect(result.embedding).toBeInstanceOf(Float32Array);
    expect(result.embedding.length).toBe(256);
    expect(Array.from(result.embedding)).toEqual(new Array(256).fill(0));
    expect(result.zones).toEqual([{ zone: 'none', score: 1.0 }]);
    expect(result.checkpointId).toBe('stub:kartograf/v1.onnx');
  });

  it('embedBatch returns one output per input', async () => {
    const session = await createKartografSession(baseConfig);
    const results = await session.embedBatch(['a', 'b', 'c']);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.embedding.length).toBe(256);
    }
  });

  it('respects custom embedding_dim', async () => {
    const session = await createKartografSession({
      ...baseConfig,
      headsConfig: { ...baseConfig.headsConfig, embedding_dim: 128 },
    });
    const result = await session.embed('x');
    expect(result.embedding.length).toBe(128);
  });

  it('close() makes embed() throw', async () => {
    const session = await createKartografSession(baseConfig);
    await session.close();
    await expect(session.embed('x')).rejects.toThrow('KartografSession is closed');
  });

  it('close() is idempotent', async () => {
    const session = await createKartografSession(baseConfig);
    await session.close();
    await expect(session.close()).resolves.toBeUndefined();
  });
});
