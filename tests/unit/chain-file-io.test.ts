import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  realFsPromises: undefined as
    | (typeof import('node:fs/promises'))
    | undefined,
}));

vi.mock('node:fs/promises', async () => {
  refs.realFsPromises =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...refs.realFsPromises,
    readFile: vi.fn(refs.realFsPromises.readFile),
  };
});

import { readFile } from 'node:fs/promises';

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
//   - overwriting an existing block succeeds without corrupting siblings
//   - genesis (index 0) is never overwritten, even if a buggy caller asks
//   - when the post-rename verification read diverges (corruption, race,
//     trailing garbage), the function rolls back: restore prev bytes, or
//     unlink the file when no prev exists

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

  it('overwrites an existing block, replacing previous bytes exactly', async () => {
    const dir = freshDir();
    const prev = JSON.stringify({ index: 3, hash: 'p3', data: { v: 1 } });
    writeFileSync(join(dir, '000003.json'), prev, 'utf8');

    const next = JSON.stringify({ index: 3, hash: 'p3b', data: { v: 2 } });
    await writeBlockAtomic(dir, 3, next);

    expect(readFileSync(join(dir, '000003.json'), 'utf8')).toBe(next);
    // The `data.v` discriminator proves previous bytes were not retained
    // (prev used v:1, next uses v:2). Asserting on `data.v` is robust
    // against other field overlap (e.g. shared `index: 3`).
    expect(readFileSync(join(dir, '000003.json'), 'utf8')).toContain(
      '"v":2',
    );
    expect(readFileSync(join(dir, '000003.json'), 'utf8')).not.toContain(
      '"v":1',
    );
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

  it('rolls back to previous bytes when verification read diverges', async () => {
    const dir = freshDir();
    const prev = JSON.stringify({ index: 5, hash: 'p5', data: { v: 1 } });
    writeFileSync(join(dir, '000005.json'), prev, 'utf8');

    // readFile is called twice for index 5 inside writeBlockAtomic:
    //   1st — read previousBytes (must return real previous content)
    //   2nd — post-rename verification (must diverge to trigger rollback)
    // Both readFile calls go through the vi.fn; we keep the default real
    // implementation for the 1st call and queue a divergent response for
    // the 2nd.
    vi.mocked(readFile)
      .mockImplementationOnce(refs.realFsPromises!.readFile)
      .mockImplementationOnce(
        async () =>
          // biome-ignore lint/suspicious/noExplicitAny: mock return type narrowing
          'TORN-WRITE-GARBAGE-NOT-MATCHING-PAYLOAD' as any,
      );

    const intended = JSON.stringify({ index: 5, hash: 'p5b', data: { v: 2 } });
    await expect(writeBlockAtomic(dir, 5, intended)).rejects.toThrow(
      /verification failed/i,
    );

    // Previous content restored, not the divergent garbage, not the
    // intended payload. Operator can re-run the originating append.
    expect(readFileSync(join(dir, '000005.json'), 'utf8')).toBe(prev);
  });

  it('unlinks the corrupted file when no previous bytes exist', async () => {
    const dir = freshDir();
    // No 000009.json exists before the call → no previousBytes → rollback
    // removes the file entirely so the next-index computation treats this
    // slot as empty and the chain integrity sweep can rebuild it.

    // Only one readFile call inside writeBlockAtomic for a fresh slot: the
    // post-rename verification. Override with garbage so it diverges.
    vi.mocked(readFile).mockImplementationOnce(
      async () =>
        // biome-ignore lint/suspicious/noExplicitAny: mock return type narrowing
        'DIVERGENT-RACE-AFTER-RENAME' as any,
    );

    const intended = JSON.stringify({ index: 9, hash: 'h9', data: { v: 1 } });
    await expect(writeBlockAtomic(dir, 9, intended)).rejects.toThrow(
      /verification failed/i,
    );

    expect(existsSync(join(dir, '000009.json'))).toBe(false);
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
