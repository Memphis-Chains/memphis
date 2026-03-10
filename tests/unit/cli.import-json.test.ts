import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

describe('CLI chain import_json', () => {
  it('imports and validates basic JSON chain payload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-chain-import-'));
    const chainPath = join(dir, 'chain.json');
    writeFileSync(
      chainPath,
      JSON.stringify([
        { index: 0, prev_hash: '0'.repeat(64), hash: 'h0' },
        { index: 1, prev_hash: 'h0', hash: 'h1' },
      ]),
    );

    const out = execSync(`npx tsx src/infra/cli/index.ts chain import_json --file ${chainPath} --json`, {
      encoding: 'utf8',
    });

    const data = JSON.parse(out);
    expect(data.imported).toBe(2);
    expect(data.valid).toBe(true);
    expect(data.policy.idempotentKey).toBe('hash');
    expect(Array.isArray(data.blocks)).toBe(true);
    expect(data.write.mode).toBe('dry-run');
  });

  it('prints migration report in text mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-chain-import-txt-'));
    const chainPath = join(dir, 'chain.json');
    writeFileSync(chainPath, JSON.stringify({ chain: [{ idx: 9, prevHash: '', hash: 'h0' }] }));

    const out = execSync(`npx tsx src/infra/cli/index.ts chain import_json --file ${chainPath}`, {
      encoding: 'utf8',
    });

    expect(out).toContain('Imported 1/1 entries...');
    expect(out).toContain('import_json migration report');
    expect(out).toContain('source: legacy.chain');
    expect(out).toContain('mode: dry-run');
    expect(out).toContain('Timing:');
  });

  it('supports --batch-size and reports metadata in json output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-chain-import-batch-'));
    const chainPath = join(dir, 'chain.json');
    writeFileSync(
      chainPath,
      JSON.stringify(
        Array.from({ length: 5 }, (_, i) => ({
          index: i,
          prev_hash: i === 0 ? '0'.repeat(64) : `h${i - 1}`,
          hash: `h${i}`,
        })),
      ),
    );

    const out = execSync(`npx tsx src/infra/cli/index.ts chain import_json --file ${chainPath} --batch-size 2 --json`, {
      encoding: 'utf8',
      env: { ...process.env, IMPORT_CONCURRENCY: '2' },
    });

    const data = JSON.parse(out);
    expect(data.imported).toBe(5);
    expect(data.batchSize).toBe(2);
    expect(data.importConcurrency).toBe(2);
    expect(typeof data.durationMs).toBe('number');
  });

  it('fails in strict mode when invalid entries are present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-chain-import-strict-'));
    const chainPath = join(dir, 'chain.json');
    writeFileSync(chainPath, JSON.stringify([{ bad: true }, { hash: 'ok' }]));

    expect(() => {
      execSync(`npx tsx src/infra/cli/index.ts chain import_json --file ${chainPath} --strict --json`, {
        encoding: 'utf8',
      });
    }).toThrow(/Strict import failed/);
  });

  it('writes transactionally only with explicit write + confirmation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-chain-import-write-'));
    const chainPath = join(dir, 'chain.json');
    const outPath = join(dir, 'persisted.json');

    writeFileSync(
      chainPath,
      JSON.stringify([
        { index: 0, prev_hash: '0'.repeat(64), hash: 'a0' },
        { index: 1, prev_hash: 'a0', hash: 'a1' },
      ]),
    );

    const out = execSync(
      `npx tsx src/infra/cli/index.ts chain import_json --file ${chainPath} --write --confirm-write --out ${outPath} --json`,
      {
        encoding: 'utf8',
      },
    );

    const data = JSON.parse(out);
    expect(data.write.mode).toBe('write');
    expect(data.write.targetPath).toBe(outPath);

    const persisted = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(persisted.blocks).toHaveLength(2);
  });

  it('blocks mutation without confirmation flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-chain-import-guard-'));
    const chainPath = join(dir, 'chain.json');
    const outPath = join(dir, 'persisted.json');

    writeFileSync(chainPath, JSON.stringify([{ index: 0, prev_hash: '0'.repeat(64), hash: 'h0' }]));

    expect(() => {
      execSync(`npx tsx src/infra/cli/index.ts chain import_json --file ${chainPath} --write --out ${outPath}`, {
        encoding: 'utf8',
      });
    }).toThrow(/Write mode blocked/);
  });
});
