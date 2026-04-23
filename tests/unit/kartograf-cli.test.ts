import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { kartografCommandHandler } from '../../src/infra/cli/handlers/kartograf.handler.js';
import {
  sha256Hex,
  signCheckpoint,
  type UnsignedEnvelope,
} from '../../src/kartograf/checkpoint.js';

function tempDir(prefix = 'karto-cli-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function unsigned(over: Partial<UnsignedEnvelope> = {}): UnsignedEnvelope {
  return {
    version: 'kartograf-v1',
    base_model: 'answerdotai/ModernBERT-base@rev-abc123',
    onnx_sha256: 'a'.repeat(64),
    tokenizer_sha256: 'b'.repeat(64),
    heads_config: { embedding_dim: 256, zone_classes: 12, multitask_alpha: 0.7 },
    training_provenance: {
      trained_at: '2026-05-15T10:00:00Z',
      corpus_version: 'v1',
      hardware: 'gtx-960-local',
      eval_recall_at_10: 0.82,
      steps: 12000,
    },
    distribution_source: 'file',
    ...over,
  };
}

function mkCtx(args: Record<string, unknown>): {
  args: Record<string, unknown> & { command: 'kartograf' };
  getContainer: () => unknown;
  getConfig: () => unknown;
} {
  return {
    args: { command: 'kartograf', ...args },
    getContainer: () => ({}),
    getConfig: () => ({}),
  };
}

describe('memphis kartograf CLI (N40.2)', () => {
  it('verify succeeds on a freshly signed envelope', async () => {
    const dir = tempDir();
    const seed = randomBytes(32);
    const envelope = signCheckpoint(unsigned(), seed);
    const envelopePath = join(dir, 'checkpoint.json');
    writeFileSync(envelopePath, JSON.stringify(envelope));
    // Capture stdout via console spy
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await kartografCommandHandler.handle(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mkCtx({ subcommand: 'verify', file: envelopePath, json: true }) as any,
    );
    const out = JSON.parse(spy.mock.calls[0][0] as string);
    spy.mockRestore();
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('kartograf.verify');
    expect(out.signerDid).toMatch(/^did:key:ed25519:/);
  });

  it('verify fails with reason on tampered envelope', async () => {
    const dir = tempDir();
    const seed = randomBytes(32);
    const signed = signCheckpoint(unsigned(), seed);
    // Tamper after signing
    const tampered = { ...signed, onnx_sha256: 'c'.repeat(64) };
    const envelopePath = join(dir, 'checkpoint.json');
    writeFileSync(envelopePath, JSON.stringify(tampered));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await kartografCommandHandler.handle(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mkCtx({ subcommand: 'verify', file: envelopePath, json: true }) as any,
    );
    const out = JSON.parse(spy.mock.calls[0][0] as string);
    spy.mockRestore();
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/signature/);
  });

  it('install refuses to stage a tampered envelope', async () => {
    const dir = tempDir();
    const seed = randomBytes(32);
    const tampered = { ...signCheckpoint(unsigned(), seed), onnx_sha256: 'c'.repeat(64) };
    const envelopePath = join(dir, 'checkpoint.json');
    writeFileSync(envelopePath, JSON.stringify(tampered));

    const dataDir = tempDir('karto-data-');
    process.env.MEMPHIS_DATA_DIR = dataDir;

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await kartografCommandHandler.handle(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mkCtx({ subcommand: 'install', file: envelopePath, source: 'file', json: true }) as any,
    );
    const out = JSON.parse(spy.mock.calls[0][0] as string);
    spy.mockRestore();
    delete process.env.MEMPHIS_DATA_DIR;
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/signature/);
  });

  it('install rejects unimplemented network sources with actionable message', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'placeholder.json'), '{}');
    await expect(
      kartografCommandHandler.handle(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mkCtx({
          subcommand: 'install',
          file: join(dir, 'placeholder.json'),
          source: 'hf-hub',
          json: true,
        }) as any,
      ),
    ).rejects.toThrow(/network fetch not yet implemented/);
  });

  it('install stages envelope + matching artifacts into data dir', async () => {
    const dir = tempDir();
    const seed = randomBytes(32);
    const onnxBytes = Buffer.from('fake-onnx-bytes');
    const tokBytes = Buffer.from('{"tokenizer":"fake"}');
    writeFileSync(join(dir, 'model.onnx'), onnxBytes);
    writeFileSync(join(dir, 'tokenizer.json'), tokBytes);
    const envelope = signCheckpoint(
      unsigned({
        onnx_sha256: sha256Hex(onnxBytes),
        tokenizer_sha256: sha256Hex(tokBytes),
      }),
      seed,
    );
    const envelopePath = join(dir, 'checkpoint.json');
    writeFileSync(envelopePath, JSON.stringify(envelope));

    const dataDir = tempDir('karto-data-');
    process.env.MEMPHIS_DATA_DIR = dataDir;

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await kartografCommandHandler.handle(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mkCtx({ subcommand: 'install', file: envelopePath, source: 'file', json: true }) as any,
    );
    const out = JSON.parse(spy.mock.calls[0][0] as string);
    spy.mockRestore();
    delete process.env.MEMPHIS_DATA_DIR;

    expect(out.ok).toBe(true);
    expect(out.artifactWarnings).toEqual([]);
    // Re-read the staged envelope and confirm it matches the input.
    const stagedEnvelope = JSON.parse(readFileSync(out.envelopeOut, 'utf8'));
    expect(stagedEnvelope.signer_did).toBe(envelope.signer_did);
  });

  it('install warns (non-fatal) when artifact sha256 mismatches envelope', async () => {
    const dir = tempDir();
    const seed = randomBytes(32);
    // Write a truthful onnx but a TAMPERED tokenizer
    const onnxBytes = Buffer.from('fake-onnx-bytes');
    writeFileSync(join(dir, 'model.onnx'), onnxBytes);
    writeFileSync(join(dir, 'tokenizer.json'), 'tampered-content');
    const envelope = signCheckpoint(
      unsigned({
        onnx_sha256: sha256Hex(onnxBytes),
        tokenizer_sha256: sha256Hex('correct-content'),
      }),
      seed,
    );
    const envelopePath = join(dir, 'checkpoint.json');
    writeFileSync(envelopePath, JSON.stringify(envelope));

    const dataDir = tempDir('karto-data-');
    process.env.MEMPHIS_DATA_DIR = dataDir;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await kartografCommandHandler.handle(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mkCtx({ subcommand: 'install', file: envelopePath, source: 'file', json: true }) as any,
    );
    const out = JSON.parse(spy.mock.calls[0][0] as string);
    spy.mockRestore();
    delete process.env.MEMPHIS_DATA_DIR;

    expect(out.ok).toBe(true);
    // Envelope is still valid (signature + declared sha256s match by canonical form);
    // tokenizer warning surfaces because the on-disk bytes don't match.
    const joined = (out.artifactWarnings as string[]).join(' | ');
    expect(joined).toMatch(/tokenizer\.json.*sha256 mismatch/);
  });
});

// `mkdirSync` is imported for type-level readability in test helpers;
// reference it so noUnusedLocals doesn't fire in some strict configs.
void mkdirSync;
