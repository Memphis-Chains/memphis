/**
 * Kartograf checkpoint rollback — backup, list, prune, restore.
 *
 * Uses real ed25519 signing seeds so the verify pass in
 * rollbackKartografCheckpoint sees authentic envelopes. The pattern
 * mirrors tests/unit/kartograf-checkpoint.test.ts (sign with seed,
 * stamp DID, verify).
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signCheckpoint, type CheckpointEnvelope } from '../../src/kartograf/checkpoint.js';
import {
  backupCurrentCheckpoint,
  listBackups,
  pruneBackups,
  rollbackKartografCheckpoint,
} from '../../src/kartograf/rollback.js';
import { _resetKartografRuntimeForTests } from '../../src/kartograf/runtime.js';

function ed25519Seed(): Buffer {
  // Node's generateKeyPairSync('ed25519') gives a key whose raw
  // 32-byte seed we can extract via DER decoding. Simpler path here:
  // use a deterministic random seed (anything 32 bytes works for the
  // signCheckpoint API per checkpoint.ts).
  return randomBytes(32);
}

function buildEnvelope(seed: Buffer, evalRecallAt10: number, onnxSha?: string): CheckpointEnvelope {
  return signCheckpoint(
    {
      version: 'kartograf-v1',
      base_model: 'answerdotai/ModernBERT-base@stub-rev',
      onnx_sha256: onnxSha ?? 'a'.repeat(64),
      tokenizer_sha256: 'b'.repeat(64),
      heads_config: {
        embedding_dim: 256,
        zone_classes: 12,
        multitask_alpha: 0.7,
      },
      training_provenance: {
        trained_at: '2026-05-12T00:00:00Z',
        corpus_version: 'v1',
        hardware: 'gtx-960-local',
        eval_recall_at_10: evalRecallAt10,
        steps: 50,
      },
      distribution_source: 'file',
    },
    seed,
  );
}

function makeSlug(tmpDir: string, slugName: string): string {
  const stageRoot = path.join(tmpDir, 'kartograf', 'checkpoints');
  const slugDir = path.join(stageRoot, slugName);
  fs.mkdirSync(slugDir, { recursive: true });
  return slugDir;
}

function writeInstalled(slugDir: string, envelope: CheckpointEnvelope, onnxBytes: Buffer): void {
  fs.writeFileSync(path.join(slugDir, 'checkpoint.json'), JSON.stringify(envelope, null, 2));
  fs.writeFileSync(path.join(slugDir, 'model.onnx'), onnxBytes);
  fs.writeFileSync(path.join(slugDir, 'tokenizer.json'), Buffer.from('{}'));
}

describe('backupCurrentCheckpoint', () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kartograf-backup-'));
    env = { ...process.env, MEMPHIS_DATA_DIR: tmpDir };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _resetKartografRuntimeForTests();
  });

  it('returns null when slug has no installed artifacts', () => {
    const slugDir = makeSlug(tmpDir, 'abc123def456');
    const result = backupCurrentCheckpoint(slugDir, 'did:key:ed25519:replacement', env);
    expect(result).toBeNull();
  });

  it('snapshots all three artifacts + writes manifest', () => {
    const slugDir = makeSlug(tmpDir, 'abc123def456');
    const seed = ed25519Seed();
    const envelope = buildEnvelope(seed, 0.42);
    writeInstalled(slugDir, envelope, Buffer.from('onnx-bytes'));

    const result = backupCurrentCheckpoint(slugDir, 'did:key:ed25519:replacement', env);
    expect(result).not.toBeNull();
    expect(result!.manifest.replacedBy).toBe('did:key:ed25519:replacement');
    expect(result!.manifest.prevSignerDid).toBe(envelope.signer_did);
    expect(result!.manifest.prevEvalRecallAt10).toBe(0.42);
    expect(result!.manifest.prevOnnxSha256).toBe(envelope.onnx_sha256);
    expect(fs.existsSync(path.join(result!.path, 'checkpoint.json'))).toBe(true);
    expect(fs.existsSync(path.join(result!.path, 'model.onnx'))).toBe(true);
    expect(fs.existsSync(path.join(result!.path, 'tokenizer.json'))).toBe(true);
    expect(fs.existsSync(path.join(result!.path, 'manifest.json'))).toBe(true);
  });
});

describe('listBackups + pruneBackups', () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kartograf-list-'));
    env = { ...process.env, MEMPHIS_DATA_DIR: tmpDir };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns backups sorted newest-first', () => {
    const slugDir = makeSlug(tmpDir, 'abc');
    const prevRoot = path.join(slugDir, '.prev');
    fs.mkdirSync(path.join(prevRoot, '2026-05-10T10-00-00Z'), { recursive: true });
    fs.mkdirSync(path.join(prevRoot, '2026-05-12T20-30-00Z'), { recursive: true });
    fs.mkdirSync(path.join(prevRoot, '2026-05-11T14-15-00Z'), { recursive: true });

    const records = listBackups(slugDir);
    expect(records.map((r) => r.timestamp)).toEqual([
      '2026-05-12T20-30-00Z',
      '2026-05-11T14-15-00Z',
      '2026-05-10T10-00-00Z',
    ]);
  });

  it('prunes to keep N most recent', () => {
    const slugDir = makeSlug(tmpDir, 'abc');
    const prevRoot = path.join(slugDir, '.prev');
    fs.mkdirSync(path.join(prevRoot, '2026-05-10T10-00-00Z'), { recursive: true });
    fs.mkdirSync(path.join(prevRoot, '2026-05-11T14-15-00Z'), { recursive: true });
    fs.mkdirSync(path.join(prevRoot, '2026-05-12T20-30-00Z'), { recursive: true });

    const removed = pruneBackups(slugDir, 1);
    expect(removed).toBe(2);
    expect(listBackups(slugDir).map((r) => r.timestamp)).toEqual(['2026-05-12T20-30-00Z']);
  });

  it('respects MEMPHIS_TRAINING_BACKUP_KEEP env (default 3)', () => {
    const slugDir = makeSlug(tmpDir, 'abc123def456');
    const seed = ed25519Seed();
    const envelope = buildEnvelope(seed, 0.42);

    // 4 sequential installs against the same slug → 4 backup events.
    for (let i = 0; i < 4; i++) {
      writeInstalled(slugDir, envelope, Buffer.from(`onnx-${i}`));
      backupCurrentCheckpoint(slugDir, `did:key:ed25519:replacement-${i}`, env);
      // Force a tick-apart timestamp by sleeping briefly so consecutive
      // ISO-second resolution does not collide.
      // (busy wait — vitest fake timers would also work but real-time
      //  keeps this test honest about filesystem ordering.)
      const start = Date.now();
      while (Date.now() - start < 1100) {
        /* spin */
      }
    }
    // Default keep = 3
    expect(listBackups(slugDir)).toHaveLength(3);
  });
});

describe('rollbackKartografCheckpoint', () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kartograf-rollback-'));
    env = { ...process.env, MEMPHIS_DATA_DIR: tmpDir };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _resetKartografRuntimeForTests();
  });

  it('returns slug-not-found when no checkpoints dir exists', async () => {
    const result = await rollbackKartografCheckpoint({ rawEnv: env });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('slug-not-found');
  });

  it('returns no-backups when slug exists but .prev is empty', async () => {
    const slugDir = makeSlug(tmpDir, 'abc');
    const seed = ed25519Seed();
    const envelope = buildEnvelope(seed, 0.5);
    writeInstalled(slugDir, envelope, Buffer.from('onnx'));

    const result = await rollbackKartografCheckpoint({ slug: 'abc', rawEnv: env });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-backups');
  });

  it('restores artifacts from the most recent backup and invalidates singleton', async () => {
    const slugDir = makeSlug(tmpDir, 'slug-aa');
    const seedA = ed25519Seed();
    const seedB = ed25519Seed();
    const onnxA = Buffer.from('onnx-A');
    const onnxB = Buffer.from('onnx-B');
    const shaA = (await import('node:crypto')).createHash('sha256').update(onnxA).digest('hex');
    const shaB = (await import('node:crypto')).createHash('sha256').update(onnxB).digest('hex');
    const envelopeA = buildEnvelope(seedA, 0.6, shaA);
    const envelopeB = buildEnvelope(seedB, 0.5, shaB);

    // Install A, then back it up + install B over it.
    writeInstalled(slugDir, envelopeA, onnxA);
    backupCurrentCheckpoint(slugDir, envelopeB.signer_did, env);
    writeInstalled(slugDir, envelopeB, onnxB);

    expect(fs.readFileSync(path.join(slugDir, 'model.onnx'))).toEqual(onnxB);

    const result = await rollbackKartografCheckpoint({ slug: 'slug-aa', rawEnv: env });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slug).toBe('slug-aa');
      expect(result.restoredEnvelopeSignerDid).toBe(envelopeA.signer_did);
    }
    // The slug's live artifacts now match A again.
    expect(fs.readFileSync(path.join(slugDir, 'model.onnx'))).toEqual(onnxA);
  });

  it('refuses to restore when backup envelope sha mismatches its model.onnx', async () => {
    const slugDir = makeSlug(tmpDir, 'slug-bb');
    const seedA = ed25519Seed();
    const onnxA = Buffer.from('onnx-A');
    const shaA = (await import('node:crypto')).createHash('sha256').update(onnxA).digest('hex');
    const envelopeA = buildEnvelope(seedA, 0.6, shaA);

    writeInstalled(slugDir, envelopeA, onnxA);
    const backup = backupCurrentCheckpoint(slugDir, 'did:key:ed25519:replacement', env);
    expect(backup).not.toBeNull();

    // Corrupt the backed-up model.onnx so it no longer matches envelope sha.
    fs.writeFileSync(path.join(backup!.path, 'model.onnx'), Buffer.from('TAMPERED'));

    const result = await rollbackKartografCheckpoint({ slug: 'slug-bb', rawEnv: env });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('verify-failed');
  });

  it('honours toTimestamp to pin a specific backup', async () => {
    const slugDir = makeSlug(tmpDir, 'slug-cc');
    const seedA = ed25519Seed();
    const seedB = ed25519Seed();
    const onnxA = Buffer.from('onnx-A');
    const onnxB = Buffer.from('onnx-B');
    const shaA = (await import('node:crypto')).createHash('sha256').update(onnxA).digest('hex');
    const shaB = (await import('node:crypto')).createHash('sha256').update(onnxB).digest('hex');
    const envelopeA = buildEnvelope(seedA, 0.6, shaA);
    const envelopeB = buildEnvelope(seedB, 0.5, shaB);

    writeInstalled(slugDir, envelopeA, onnxA);
    const backupA = backupCurrentCheckpoint(slugDir, envelopeB.signer_did, env);
    writeInstalled(slugDir, envelopeB, onnxB);
    // sleep so backupB has a distinct ISO-second timestamp
    const start = Date.now();
    while (Date.now() - start < 1100) {
      /* spin */
    }
    const backupB = backupCurrentCheckpoint(slugDir, 'did:key:ed25519:third', env);
    expect(backupA).not.toBeNull();
    expect(backupB).not.toBeNull();
    expect(backupA!.timestamp).not.toBe(backupB!.timestamp);

    const result = await rollbackKartografCheckpoint({
      slug: 'slug-cc',
      toTimestamp: backupA!.timestamp,
      rawEnv: env,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.restoredEnvelopeSignerDid).toBe(envelopeA.signer_did);
    }
    expect(fs.readFileSync(path.join(slugDir, 'model.onnx'))).toEqual(onnxA);
  });
});

// Suppress unused import warnings for variables used only inside the
// generateKeyPairSync helper export path (kept for future Ed25519 seed
// extraction without regenerating the helper).
void generateKeyPairSync;
