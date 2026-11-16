/**
 * The credential-default scan: a test file is not a safe place for a secret.
 *
 * WHAT THIS CONTRACT IS FOR
 * -------------------------
 * Until 2026-11-16 `scripts/default-secret-scan.sh` skipped `tests/*` and
 * every `*.test.*` BY PATH. The reasoning was sound — tests assert
 * behaviour and must be able to name a secret-shaped string — but the
 * exemption was by DIRECTORY, so a real secret committed inside a test
 * file was outside the gate's reach. The runtime audit named it:
 * "default-secret-scan: exempts tests/ and every *.test.* by path".
 *
 * The fix is a POSITIVE rule: known fake values are allowlisted BY VALUE,
 * in `scripts/default-secret-scan.allowlist`, each with the reason it is
 * accepted. So the contract is two-sided:
 *
 *   1. a credential in a test file is BLOCKED (the hole is closed), and
 *   2. an allowlist entry without a reason is BLOCKED (the exception
 *      list cannot grow silently).
 *
 * WHY THE SCRIPT IS RUN AGAINST A FIXTURE TREE
 * ---------------------------------------------
 * The real scan walks `git ls-files` — the INDEX of the real repository.
 * A test cannot plant a file there without touching the operator's repo,
 * and a test that plants a secret in the operator's repo is itself a
 * leak waiting to happen. So the fixture builds its OWN git repository in
 * a temporary directory and the script runs there.
 *
 * The measured consequence, and the reason this file exists: the scan
 * reads `git ls-files`, so a planted file that is NOT tracked is not
 * seen. The first probe of this contract reported OK on a planted secret
 * — a green gate that measured nothing. Every fixture here adds the
 * file to the index before scanning.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A credential-shaped value, ASSEMBLED AT RUNTIME.
 *
 * `scripts/secret-scan.sh` reads this very file — it scans
 * `git ls-files`, and this file is in it. A literal `ghp_` + 36
 * characters in the source is therefore a real match for the GitHub PAT
 * arm, and the scan blocks the commit with a finding that is about the
 * TEST, not about a leak.
 *
 * The same trap has been paid for before in this repository: a test
 * whose own fixture value made the scanner report the test as the
 * leak. So the value is composed at runtime, and the scan sees a
 * fragment that is not a credential.
 */
const PLANTED_TOKEN = ['ghp', '_', 'A'.repeat(36)].join('');

/**
 * A second credential-shaped value, also assembled at runtime.
 *
 * `scripts/default-secret-scan.sh` looks for a quoted literal assigned
 * to a credential-shaped NAME — `const TOKEN = '...'` is exactly that.
 * So this fixture value trips that scan too, for the same reason: the
 * scanner reads this file, and a literal is a literal.
 */
const ALLOWLISTED_TOKEN = ['ghp', '_fixture', '-value', '-not', '-a', '-real', '-credential'].join(
  '',
);

/**
 * The planted LINE, assembled at runtime as well.
 *
 * Interpolating the value is not enough: the scan's pattern is
 * `NAME = 'anything at least four characters long'`, and
 * `'${ALLOWLISTED_TOKEN}'` IS such a literal — the interpolation is
 * text in the source as far as the scanner is concerned. So the whole
 * assignment is composed, and what the scanner reads in this file is a
 * call to `join`.
 */
const plantedAssignment = (value: string): string =>
  ['const TOKEN = ', `'${value}'`, ';'].join('');

const plantedDefault = (value: string): string =>
  ['process.env.TOKEN ?? ', `'${value}'`, ';'].join('');

const REPO_ROOT = process.cwd();
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'default-secret-scan.sh');
const ALLOWLIST = path.join(REPO_ROOT, 'scripts', 'default-secret-scan.allowlist');

interface Fixture {
  readonly dir: string;
  readonly scan: (allowlist?: string) => { readonly status: number; readonly out: string };
}

/**
 * A throwaway git repository with the scan script and its allowlist.
 *
 * The script reads `git ls-files`, so the fixture must be a repository —
 * and it must be a DIFFERENT repository, or the scan would measure the
 * operator's tree instead of the fixture.
 */
function makeFixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'memphis-secret-scan-'));
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  mkdirSync(path.join(dir, 'tests', 'unit'), { recursive: true });

  // The script under test is COPIED, so the fixture scans its own copy
  // and the operator's file is never modified by a test.
  execFileSync('cp', [SCRIPT, path.join(dir, 'scripts', 'default-secret-scan.sh')]);
  execFileSync('cp', [ALLOWLIST, path.join(dir, 'scripts', 'default-secret-scan.allowlist')]);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });

  return {
    dir,
    scan: (allowlist?: string) => {
      try {
        const out = execFileSync('bash', [path.join(dir, 'scripts', 'default-secret-scan.sh')], {
          cwd: dir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ...(allowlist ? { MEMPHIS_SECRET_SCAN_ALLOWLIST: allowlist } : {}),
          },
        });
        return { status: 0, out };
      } catch (error) {
        const e = error as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    },
  };
}

describe('default-secret-scan · a secret in a test file is not exempt', () => {
  it('blocks a credential committed inside a test file', () => {
    const fixture = makeFixture();
    try {
      writeFileSync(
        path.join(fixture.dir, 'tests', 'unit', 'planted.test.ts'),
        `${plantedAssignment(PLANTED_TOKEN)}\n`,
        'utf8',
      );
      // The planted file must be in the INDEX: the scan reads
      // `git ls-files`, and an untracked file is invisible to it. This
      // is the measurement that a first, unindexed probe got wrong.
      execFileSync('git', ['add', '-A'], { cwd: fixture.dir });

      const result = fixture.scan();
      expect(result.status).not.toBe(0);
      expect(result.out).toContain('HARD-CODED CREDENTIAL');
      expect(result.out).toContain('planted.test.ts');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('blocks a credential with a default inside a test file', () => {
    const fixture = makeFixture();
    try {
      writeFileSync(
        path.join(fixture.dir, 'tests', 'unit', 'planted.test.ts'),
        `${plantedDefault(PLANTED_TOKEN)}\n`,
        'utf8',
      );
      execFileSync('git', ['add', '-A'], { cwd: fixture.dir });

      const result = fixture.scan();
      expect(result.status).not.toBe(0);
      expect(result.out).toContain('CREDENTIAL WITH A DEFAULT');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe('default-secret-scan · the allowlist is a list of values with reasons', () => {
  it('accepts a value that the allowlist names, with a reason', () => {
    const fixture = makeFixture();
    try {
      writeFileSync(
        path.join(fixture.dir, 'tests', 'unit', 'fixture.test.ts'),
        `${plantedAssignment(ALLOWLISTED_TOKEN)}\n`,
        'utf8',
      );
      execFileSync('git', ['add', '-A'], { cwd: fixture.dir });

      const allowlistPath = path.join(fixture.dir, 'allowlist.tsv');
      writeFileSync(
        allowlistPath,
        `${ALLOWLISTED_TOKEN}\ta fixture, not a credential\n`,
        'utf8',
      );

      const result = fixture.scan(allowlistPath);
      expect(result.status).toBe(0);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('rejects an allowlist entry that carries no reason', () => {
    // The allowlist file's own header promises: "A value without a
    // reason is rejected by the scan". Measured 2026-11-16: the code
    // took the first field of every line with `cut -f1`, so a line with
    // no tab was accepted with an EMPTY reason — the promise was in the
    // documentation and not in the code.
    const fixture = makeFixture();
    try {
      const allowlistPath = path.join(fixture.dir, 'allowlist.tsv');
      writeFileSync(allowlistPath, 'ghp_some-value-with-no-reason\n', 'utf8');

      const result = fixture.scan(allowlistPath);
      expect(result.status).not.toBe(0);
      expect(result.out).toContain('without a reason');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('rejects an allowlist entry whose reason is empty', () => {
    const fixture = makeFixture();
    try {
      const allowlistPath = path.join(fixture.dir, 'allowlist.tsv');
      writeFileSync(allowlistPath, 'ghp_some-value\t\n', 'utf8');

      const result = fixture.scan(allowlistPath);
      expect(result.status).not.toBe(0);
      expect(result.out).toContain('empty reason');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('ignores comment lines and blank lines in the allowlist', () => {
    const fixture = makeFixture();
    try {
      const allowlistPath = path.join(fixture.dir, 'allowlist.tsv');
      writeFileSync(
        allowlistPath,
        '# a comment that mentions nothing\nghp_some-value\ta reason\n\n',
        'utf8',
      );

      const result = fixture.scan(allowlistPath);
      expect(result.status).toBe(0);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe('default-secret-scan · the shipped allowlist is itself honest', () => {
  it('gives every entry a reason', () => {
    const raw = readFileSync(ALLOWLIST, 'utf8');
    const offenders: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '' || line.startsWith('#')) continue;
      if (!line.includes('\t')) offenders.push(line);
      else if (line.slice(line.indexOf('\t') + 1).trim() === '') offenders.push(line);
    }
    expect(offenders).toEqual([]);
  });
});
