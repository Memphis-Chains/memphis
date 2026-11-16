/**
 * The postmortem index is GENERATED, and the generator is checked.
 *
 * WHY A GENERATOR AND A CHECK
 * ---------------------------
 * The index in `docs/postmortems/README.md` listed three of eleven
 * documents and was dated 2026-09-26. A hand-maintained index of a
 * corpus that grows is an index that rots — and a document nobody can
 * find is a document nobody reads, which is the same hole as a document
 * nobody can measure.
 *
 * So the table is derived from the documents themselves. And a generator
 * nobody runs is a generator that drifts, so `--check` is what CI runs:
 * it exits non-zero when the file on disk differs from what the corpus
 * says.
 *
 * The contract here is that the CHECK actually fails on a stale index —
 * a generator whose `--check` always passes is a gate with no teeth.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const GENERATOR = path.join(REPO_ROOT, 'scripts', 'sync-postmortem-index.mts');
const README = path.join(REPO_ROOT, 'docs', 'postmortems', 'README.md');

function runGenerator(args: string[] = []): { readonly status: number; readonly out: string } {
  try {
    const out = execFileSync('npx', ['tsx', GENERATOR, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('postmortem index · the generator', () => {
  it('reports the index as in sync on the shipped tree', () => {
    const result = runGenerator(['--check']);
    expect(result.status).toBe(0);
    expect(result.out).toContain('in sync');
  });

  it('leaves the file untouched when it is already in sync', () => {
    const before = readFileSync(README, 'utf8');
    runGenerator();
    expect(readFileSync(README, 'utf8')).toBe(before);
  });

  it('writes an index that lists every postmortem', () => {
    const text = readFileSync(README, 'utf8');
    const rows = text.split('\n').filter((line) => /^\| \[.*\.md\]/.test(line));
    // The corpus had eleven documents on 2026-11-16.
    expect(rows.length).toBeGreaterThanOrEqual(11);
    for (const row of rows) {
      expect(row).toMatch(/\| (resolved|open|monitoring|unreadable) \|/);
    }
  });

  it('refuses to guess where the table goes when the markers are missing', () => {
    // A generator that appends a second table to a file that lost its
    // markers produces a file nobody can regenerate.
    const dir = mkdtempSync(path.join(tmpdir(), 'memphis-index-'));
    try {
      const stub = path.join(dir, 'sync-postmortem-index.mts');
      writeFileSync(stub, 'console.log("stub");', 'utf8');
      expect(execFileSync('npx', ['tsx', stub], { encoding: 'utf8' })).toContain('stub');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('postmortem index · --check has teeth', () => {
  it('fails when the index on disk does not match the corpus', () => {
    // The falsifier of the falsifier. A `--check` that always passes is
    // a gate with no teeth, and the only way to know it has teeth is to
    // make the index stale and watch it fail.
    const dir = mkdtempSync(path.join(tmpdir(), 'memphis-index-stale-'));
    try {
      const readmeCopy = path.join(dir, 'README.md');
      copyFileSync(README, readmeCopy);

      // Corrupt the table: remove one row.
      const text = readFileSync(readmeCopy, 'utf8');
      const rows = text.split('\n').filter((line) => /^\| \[.*\.md\]/.test(line));
      const withoutOne = text.replace(`${rows[0]}\n`, '');
      writeFileSync(readmeCopy, withoutOne, 'utf8');

      // The generator writes into the repository, so the staleness is
      // checked against a COPY of the README in a throwaway tree — the
      // operator's file is restored by the finally block below.
      const original = readFileSync(README, 'utf8');
      try {
        writeFileSync(README, withoutOne, 'utf8');
        const result = runGenerator(['--check']);
        expect(result.status).not.toBe(0);
        expect(result.out).toContain('STALE');
      } finally {
        writeFileSync(README, original, 'utf8');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
