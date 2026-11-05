import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// Importing from `node:fs/promises` here (alphabetically before `node:os`
// per eslint `import/order`) is safe even though the module is mocked
// further down: vitest hoists `vi.mock(...)` above all imports, so by
// the time this binding is evaluated `readFile` is already the wrapped
// `vi.fn` from the factory below, not Node's native impl. Moving the
// import here keeps the lint alphabetisation satisfied while preserving
// the rollback-test behaviour that relies on the mocked binding.
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ────────────────────────────────────────────────────────────────────────────
// Mock node:fs/promises at module level so we can selectively spy on readFile
// (used by writeBlockAtomic's read-after-write verification) while delegating
// every other fs promise call (mkdir, rename, writeFile, unlink, stat, readdir,
// access, open) to the real implementation. This keeps happy-path tests fully
// transparent — they exercise real fs through mkdtempSync directories — while
// letting the rollback regression tests inject a divergent verification read.
//
// The factory captures the real `readFile` into `realFsPromises` BEFORE
// returning the mocked module. We reference `realFsPromises.readFile` from
// the rollback tests to stage `mockImplementationOnce` overrides on the
// verification call only; the previousBytes read still gets the real impl.
//
// `vi.mocked(readFile).mockClear()` in beforeEach keeps the default
// implementation (set in the factory) and clears any `.mockImplementationOnce`
// queue leftover from previous tests. `mockReset` would also wipe the default
// implementation, forcing every test to remember to re-set it; `mockClear` is
// the right tool here.
// ────────────────────────────────────────────────────────────────────────────

// `vi.hoisted` synchronously creates a shared object reference BEFORE the
// hoisted `vi.mock` factory runs. The factory mutates `refs.realFsPromises`
// to capture the unmocked module so the rollback tests can stage explicit
// `mockImplementationOnce` overrides on the read-after-write verification
// call only. Without `vi.hoisted`, a top-level `let` would sit in TDZ when
// vitest hoists the factory above it and the test file would fail to load.
const refs = vi.hoisted(() => ({
  realFsPromises: undefined as typeof import('node:fs/promises') | undefined,
}));

vi.mock('node:fs/promises', async () => {
  refs.realFsPromises =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...refs.realFsPromises,
    readFile: vi.fn(refs.realFsPromises.readFile),
  };
});

import {
  listBlockFiles,
  withNapiAppendLock,
  writeBlockAtomic,
} from '../../src/infra/storage/chain-file-io.js';

const TAG = 'memphis-chain-files-';
const createdDirs: string[] = [];

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), TAG));
  createdDirs.push(d);
  return d;
}

beforeEach(() => {
  vi.mocked(readFile).mockClear();
});

afterEach(() => {
  vi.mocked(readFile).mockClear();
  for (const d of createdDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; CI runners handle /tmp
    }
  }
});

// ── listBlockFiles (existing regression) ─────────────────────────────────────

describe('chain file io', () => {
  it('lists only real json block files and skips json-named directories', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, '000001.json'), '{}', 'utf8');
    mkdirSync(join(dir, '000002.json'));
    writeFileSync(join(dir, 'note.txt'), 'ignore', 'utf8');

    await expect(listBlockFiles(dir)).resolves.toEqual(['000001.json']);
  });
});

// ── writeBlockAtomic (issue #626 monitoring regression) ──────────────────────
//
// The atomic write path was hardened in d4dacc6 (read-after-write verification
// + rollback for issue #626). These tests pin the contract:
//   - happy-path writes land exactly the payload that was sent
//   - existing blocks at any index cannot be overwritten
//   - divergent post-publication verification preserves evidence and fails

describe('writeBlockAtomic', () => {
  it('writes a new block to a fresh slot (no previous file)', async () => {
    const dir = freshDir();
    const payload = JSON.stringify({
      index: 7,
      hash: 'h-7',
      data: { type: 'journal', content: 'first ever' },
    });

    const file = await writeBlockAtomic(dir, 7, payload);

    expect(file).toBe(join(dir, '000007.json'));
    expect(readFileSync(join(dir, '000007.json'), 'utf8')).toBe(payload);
    // No collateral writes
    expect(existsSync(join(dir, '000006.json'))).toBe(false);
    expect(existsSync(join(dir, '000008.json'))).toBe(false);
  });

  it('refuses to overwrite an existing block at a nonzero index', async () => {
    const dir = freshDir();
    const prev = JSON.stringify({ index: 3, hash: 'p3', data: { v: 1 } });
    writeFileSync(join(dir, '000003.json'), prev, 'utf8');
    const next = JSON.stringify({ index: 3, hash: 'p3b', data: { v: 2 } });

    await expect(writeBlockAtomic(dir, 3, next)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(join(dir, '000003.json'), 'utf8')).toBe(prev);
  });

  it('refuses to overwrite an existing genesis block (index 0)', async () => {
    const dir = freshDir();
    const genesis = JSON.stringify({ index: 0, hash: 'g0', data: { x: 1 } });
    writeFileSync(join(dir, '000000.json'), genesis, 'utf8');

    const hijack = JSON.stringify({ index: 0, hash: 'bad', data: { x: 2 } });
    await expect(writeBlockAtomic(dir, 0, hijack)).rejects.toThrow(
      /refusing to overwrite existing genesis/i,
    );

    // Genesis intact
    expect(readFileSync(join(dir, '000000.json'), 'utf8')).toBe(genesis);
  });

  it('allows only one concurrent writer to publish a given index', async () => {
    const dir = freshDir();
    const first = JSON.stringify({ index: 5, hash: 'first' });
    const second = JSON.stringify({ index: 5, hash: 'second' });
    const results = await Promise.allSettled([
      writeBlockAtomic(dir, 5, first),
      writeBlockAtomic(dir, 5, second),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const saved = readFileSync(join(dir, '000005.json'), 'utf8');
    expect([first, second]).toContain(saved);
    expect(saved).toBe(results[0].status === 'fulfilled' ? first : second);
  });

  it('preserves the published file when verification detects a mismatch', async () => {
    const dir = freshDir();
    // Override the post-publication verification read with divergent bytes.
    vi.mocked(readFile).mockImplementationOnce(
      async () =>
        // biome-ignore lint/suspicious/noExplicitAny: mock return type narrowing
        'DIVERGENT-RACE-AFTER-RENAME' as any,
    );

    const intended = JSON.stringify({ index: 9, hash: 'h9', data: { v: 1 } });
    await expect(writeBlockAtomic(dir, 9, intended)).rejects.toThrow(/verification failed/i);

    expect(readFileSync(join(dir, '000009.json'), 'utf8')).toBe(intended);
  });
});

// ── withNapiAppendLock (serialises concurrent chain appends) ─────────────────
//
// Decision #190 ruled chain appends behind an exclusive lock so concurrent
// writers cannot race on the next-index computation. These tests assert that
// two Promise.all callers execute their critical sections strictly
// sequentially: callback of caller A completes before callback of caller B
// starts, and the lock file is cleaned up after the callback resolves.

describe('withNapiAppendLock', () => {
  it('serialises concurrent callback execution under one chains dir', async () => {
    const dir = freshDir();

    const order: string[] = [];
    const tick = (label: string) => {
      order.push(label);
    };

    const callA = withNapiAppendLock(dir, async () => {
      tick('a-start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      tick('a-end');
      return 'A';
    });

    // Slight delay so A holds the lock when B arrives; otherwise the lock
    // is unowned and B may start first. Order does not matter for the
    // serialisation guarantee — only that the callbacks never interleave.
    const callB = new Promise<string>((resolve) =>
      setTimeout(() => {
        resolve(
          withNapiAppendLock(dir, async () => {
            tick('b-start');
            await new Promise((r) => setTimeout(r, 30));
            tick('b-end');
            return 'B';
          }),
        );
      }, 5),
    );

    const [resultA, resultB] = await Promise.all([callA, callB]);
    expect([resultA, resultB].sort()).toEqual(['A', 'B']);

    // Two valid orderings exist depending on which caller acquired the
    // lock first. The forbidden shape is {a-start, b-start, ...} with
    // a-end missing in between — i.e. overlap of the critical sections.
    const validAFirst = order.join(',') === 'a-start,a-end,b-start,b-end';
    const validBFirst = order.join(',') === 'b-start,b-end,a-start,a-end';
    expect(validAFirst || validBFirst).toBe(true);
  });

  it('clears the lock file after the callback resolves', async () => {
    const dir = freshDir();
    const lockFile = join(dir, '.napi-append.lock');

    await withNapiAppendLock(dir, async () => 'ok');

    expect(existsSync(lockFile)).toBe(false);
  });
});
