import { expect, it, vi } from 'vitest';

vi.mock('../../src/kartograf/runtime.js', () => ({ getKartografRuntime: vi.fn() }));
import { embeddingSpaceFor } from '../../src/kartograf/embedding-space.js';
import { getKartografRuntime } from '../../src/kartograf/runtime.js';
import { runMemphisKartograf } from '../../src/mcp/tools/kartograf.js';
import { kartografBundleFixture } from '../helpers/kartograf-bundle.js';

it('publishes verified space metadata and fails closed without echoing inference diagnostics', async () => {
  const { envelope } = kartografBundleFixture();
  const space = embeddingSpaceFor(envelope);
  const result = {
    checkpointId: envelope.onnx_sha256,
    embeddingSpaceId: space.id,
    embedding: new Float32Array([0.6, 0.8]),
    zones: [{ zone: 'journal', score: 0.8 }],
  };
  const session = {
    checkpointId: envelope.onnx_sha256,
    headsConfig: envelope.heads_config,
    embeddingSpace: space,
    embed: vi.fn(async () => result),
  };
  vi.mocked(getKartografRuntime).mockResolvedValue({
    kind: 'ready',
    session,
    embeddingSpace: space,
    envelopePath: '/synthetic/checkpoint.json',
  } as never);
  const success = await runMemphisKartograf({ query: 'hello' });
  expect(success).toMatchObject({ ok: true, embeddingSpace: space, embeddingDim: 2 });
  session.embed.mockResolvedValue({ ...result, embeddingSpaceId: 'wrong-space' });
  expect(await runMemphisKartograf({ query: 'hello' })).toMatchObject({
    ok: false,
    stateKind: 'inference-failed',
  });
  session.embed.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC'));
  const failure = await runMemphisKartograf({ query: 'hello' });
  expect(failure.ok).toBe(false);
  expect(JSON.stringify(failure)).not.toContain('SYNTHETIC_PRIVATE_DIAGNOSTIC');
});
