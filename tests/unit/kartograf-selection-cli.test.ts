import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/kartograf/session.js', () => ({ createKartografSession: vi.fn() }));

import type { CliContext } from '../../src/infra/cli/context.js';
import { kartografCommandHandler } from '../../src/infra/cli/handlers/kartograf.handler.js';
import { getTensorStatus } from '../../src/infra/tensors/status.js';
import { sha256Hex, signCheckpoint } from '../../src/kartograf/checkpoint.js';
import type { CheckpointEnvelope } from '../../src/kartograf/checkpoint.js';
import { embeddingSpaceFor } from '../../src/kartograf/embedding-space.js';
import { activateBundle, installBundle } from '../../src/kartograf/installed.js';
import { closeKartografRuntime } from '../../src/kartograf/runtime.js';
import { createKartografSession } from '../../src/kartograf/session.js';

let root: string;
const originalExit = process.exitCode;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'memphis-kartograf-cli-selection-'));
  vi.stubEnv('MEMPHIS_DATA_DIR', join(root, 'runtime'));
  vi.stubEnv('MEMPHIS_HOME', join(root, 'runtime'));
  vi.stubEnv('MEMPHIS_KARTOGRAF_ENABLE', '1');
  await closeKartografRuntime();
  vi.clearAllMocks();
  process.exitCode = 0;
});
afterEach(async () => {
  await closeKartografRuntime();
  vi.unstubAllEnvs();
  process.exitCode = originalExit;
});
async function producer(name: string) {
  const directory = join(root, name);
  mkdirSync(directory);
  const model = Buffer.from('synthetic model ' + name),
    tokenizer = Buffer.from('{"synthetic":true}');
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
  const file = join(directory, 'checkpoint.json');
  writeFileSync(file, JSON.stringify(envelope));
  writeFileSync(join(directory, 'model.onnx'), model);
  writeFileSync(join(directory, 'tokenizer.json'), tokenizer);
  return { file, envelope };
}
async function call(args: Record<string, unknown>) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await kartografCommandHandler.handle({
      args: { command: 'kartograf', json: true, ...args },
    } as CliContext);
    return JSON.parse(String(log.mock.calls[0][0]));
  } finally {
    log.mockRestore();
  }
}
function mockEngine(envelope: CheckpointEnvelope) {
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

it('uses the explicitly selected bundle consistently in status, runtime and positional JSON query (mocked inference)', async () => {
  const one = await producer('one');
  await installBundle(one.file, process.env);
  const two = await producer('two');
  const selected = await installBundle(two.file, process.env);
  vi.mocked(createKartografSession).mockResolvedValue(mockEngine(two.envelope));
  await activateBundle(selected.id, two.envelope.signer_did, process.env);
  const status = await call({ subcommand: 'status' });
  expect(status.installed).toBe(2);
  expect(status.active_checkpoint).toBe(selected.id);
  const loaded = getTensorStatus({ RUST_CHAIN_ENABLED: 'false', MEMPHIS_KARTOGRAF_ENABLE: '1' });
  expect(loaded.kartograf.mode).toBe('onnx');
  expect(loaded.kartograf.checkpointId).toBe(two.envelope.onnx_sha256);
  expect(loaded.kartograf.embeddingSpace).toEqual(status.active_embedding_space);
  expect(status.active_embedding_space.id).toBe(embeddingSpaceFor(two.envelope).id);
  const query = await call({ subcommand: 'query', target: 'synthetic query' });
  expect(query.ok).toBe(true);
  expect(query.selectedCheckpointId).toBe(selected.id);
  expect(query.embedding).toHaveLength(2);
  expect(query.topZone).toBe('patterns');
  expect(query.confidence).toBe(0.9);
  expect(
    vi
      .mocked(createKartografSession)
      .mock.calls.every(([config]) => config.checkpointPath === selected.envelopePath),
  ).toBe(true);
});

it('does not claim an active checkpoint while disabled, and install activation dry-run writes nothing', async () => {
  const fixture = await producer('one');
  const preview = await call({
    subcommand: 'install',
    file: fixture.file,
    forceActive: true,
    dryRun: true,
    trustedSigner: fixture.envelope.signer_did,
  });
  expect(preview.ok).toBe(true);
  expect(preview.activated).toBe(false);
  expect(existsSync(join(root, 'runtime'))).toBe(false);
  expect(createKartografSession).not.toHaveBeenCalled();
  const selected = await installBundle(fixture.file, process.env);
  vi.mocked(createKartografSession).mockResolvedValue(mockEngine(fixture.envelope));
  await activateBundle(selected.id, fixture.envelope.signer_did, process.env);
  vi.stubEnv('MEMPHIS_KARTOGRAF_ENABLE', '0');
  const status = await call({ subcommand: 'status' });
  expect(status.selected_checkpoint).toBe(selected.id);
  expect(status.active_checkpoint).toBeNull();
  expect(status.runtime).toBe('disabled');
});

it('returns a handled inference failure and releases the query session without echoing diagnostics', async () => {
  const fixture = await producer('failed-query');
  const bundle = await installBundle(fixture.file, process.env);
  const engine = mockEngine(fixture.envelope);
  vi.mocked(createKartografSession).mockResolvedValue(engine);
  await activateBundle(bundle.id, fixture.envelope.signer_did, process.env);
  engine.embed.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC'));
  const result = await call({ subcommand: 'query', target: 'hello' });
  expect(result.ok).toBe(false);
  expect(process.exitCode).toBe(2);
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_DIAGNOSTIC');
  expect(engine.close).toHaveBeenCalledTimes(2);
});
