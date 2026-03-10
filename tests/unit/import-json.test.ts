import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { guardWriteMode, runImportJsonFromFileBatched, runImportJsonPayload, transactionalWriteBlocks } from '../../src/infra/cli/import-json.js';

describe('import_json migration semantics', () => {
  it('supports legacy {chain:[...]} payload and reconciles index/links', () => {
    const result = runImportJsonPayload({
      chain: [
        { idx: 10, prevHash: 'bad', hash: 'h0', content: 'a' },
        { idx: 22, prevHash: 'wrong', hash: 'h1', content: 'b' },
      ],
    });

    expect(result.imported).toBe(2);
    expect(result.source.shape).toBe('legacy.chain');
    expect(result.reconciliation.indexRewritten).toBe(2);
    expect(result.reconciliation.prevHashRewritten).toBe(2);
    expect(result.blocks[0]).toMatchObject({ index: 0, prev_hash: '0'.repeat(64), hash: 'h0' });
    expect(result.blocks[1]).toMatchObject({ index: 1, prev_hash: 'h0', hash: 'h1' });
  });

  it('applies idempotent duplicate-by-hash skip policy', () => {
    const result = runImportJsonPayload([
      { index: 0, prev_hash: '0'.repeat(64), hash: 'same' },
      { index: 1, prev_hash: 'same', hash: 'same' },
    ]);

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.reconciliation.duplicatesSkipped).toBe(1);
    expect(result.policy.idempotentKey).toBe('hash');
  });

  it('supports object {blocks:[...]} payload', () => {
    const result = runImportJsonPayload({
      blocks: [
        { index: 0, prev_hash: '0'.repeat(64), hash: 'h0' },
        { index: 1, prev_hash: 'h0', hash: 'h1' },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.source.shape).toBe('object.blocks');
  });

  it('blocks write mode when source and destination are the same', () => {
    expect(() => {
      guardWriteMode({
        writeEnabled: true,
        confirmationProvided: true,
        sourcePath: '/tmp/a.json',
        destinationPath: '/tmp/a.json',
      });
    }).toThrow(/must differ/);
  });

  it('writes transactionally and keeps backup of previous file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-chain-write-tx-'));
    const target = join(dir, 'chain.json');
    writeFileSync(target, JSON.stringify({ blocks: [{ hash: 'old' }] }));

    const { backupPath } = transactionalWriteBlocks(target, [
      { index: 0, prev_hash: '0'.repeat(64), hash: 'new' },
    ]);

    expect(backupPath).toBeDefined();
    const current = JSON.parse(readFileSync(target, 'utf8'));
    const backup = JSON.parse(readFileSync(backupPath!, 'utf8'));
    expect(current.blocks[0].hash).toBe('new');
    expect(backup.blocks[0].hash).toBe('old');
  });

  it('processes import in batches with progress callback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-chain-batched-'));
    const source = join(dir, 'source.json');
    writeFileSync(
      source,
      JSON.stringify(
        Array.from({ length: 6 }, (_, i) => ({
          index: i,
          prev_hash: i === 0 ? '0'.repeat(64) : `h${i - 1}`,
          hash: `h${i}`,
        })),
      ),
    );

    const progress: string[] = [];
    const report = await runImportJsonFromFileBatched(source, {
      batchSize: 2,
      concurrency: 2,
      onBatchProgress: ({ imported, total }) => progress.push(`${imported}/${total}`),
    });

    expect(report.imported).toBe(6);
    expect(report.invalidSkipped).toBe(0);
    expect(progress).toContain('2/6');
    expect(progress).toContain('6/6');
  });

  it('supports strict mode failure on invalid entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-chain-batched-strict-'));
    const source = join(dir, 'source.json');
    writeFileSync(source, JSON.stringify([{ hash: 'a' }, { bad: true }]));

    await expect(
      runImportJsonFromFileBatched(source, {
        strict: true,
      }),
    ).rejects.toThrow(/Strict import failed/);
  });
});
