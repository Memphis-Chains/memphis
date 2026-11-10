import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The branch boundary, measured.
//
// Measured 2026-11-03 on this host: crons/tuesday-code.sh pushed HEAD to
// refs/heads/main, and GitHub refused it — "failed to push some refs" —
// because the repository ruleset requires a pull request and four green
// checks. The cron ran for eleven minutes, wrote a commit, and the one
// thing it was for did not happen. The push was attempted on every run
// and refused on every run.
//
// The ruleset is the operator's decision and stays as it is. The script
// changes to work with it: a branch and a pull request.
//
// The scan below mirrors the runtime audit's own detector, so the contract
// and the audit cannot disagree about what counts as a push to a
// protected branch.

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

const PROTECTED = 'main';

/**
 * The part of a shell line that actually runs.
 *
 * A `#` that starts a word opens a comment, which is the shell's own
 * rule. A `#` inside a word — as in `https://host/#anchor` — does not.
 *
 * Measured 2026-11-10: filtering only whole-line comments let a mutation
 * through that turned the command into `true # gh pr create ...`. The
 * line still starts with `true`, so it was still "executed", and the
 * command it named was never run.
 */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1] ?? '')) return line.slice(0, i);
    }
  }
  return line;
}

/** The same shape the runtime audit's branch-boundary check looks for. */
function pushTargets(source: string): string[] {
  const targets: string[] = [];
  for (const line of source.split('\n')) {
    const match = /git\s+push[^\n]*?HEAD:refs\/heads\/([A-Za-z0-9._/-]+)/.exec(line);
    if (match) targets.push(match[1]);
  }
  return targets;
}

describe('no script pushes HEAD to a protected branch', () => {
  it('finds no push to main in any cron or script', () => {
    const offenders: string[] = [];
    for (const dir of ['crons', 'scripts']) {
      const absolute = path.join(repoRoot, dir);
      for (const file of readdirSync(absolute) as string[]) {
        if (!/\.(sh|bash|mts|mjs)$/.test(file)) continue;
        const source = readFileSync(path.join(absolute, file), 'utf8');
        for (const target of pushTargets(source)) {
          if (target === PROTECTED) offenders.push(`${dir}/${file} -> ${target}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the tuesday priority cron publishes through a pull request', () => {
    const source = readFileSync(path.join(repoRoot, 'crons', 'tuesday-code.sh'), 'utf8');
    const targets = pushTargets(source);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target).not.toBe(PROTECTED);
      expect(target).toMatch(/^chore\/priorities-/);
    }
    // A branch without a pull request is a push that lands unattended on
    // some other branch — the same class of hole, one ref away.
    //
    // The EXECUTED lines only. A comment that quotes the command is a
    // description of it, not the command — measured 2026-11-10: a
    // mutation that commented the `pr create` out left the text in the
    // file, and the assertion on the raw source still passed.
    const executed = source
      .split('\n')
      .map(stripComment)
      .filter((line) => line.trim().length > 0);
    const prCalls = executed.filter((line) => /\bpr\s+create\b/.test(line));
    expect(prCalls.length).toBeGreaterThan(0);
    for (const call of prCalls) {
      expect(call).toContain('--base main');
      expect(call).toContain('--head');
    }
  });

  it('does not reach for main through any other spelling', () => {
    // `git push origin main`, `git push origin HEAD:main` and
    // `git push origin refs/heads/main` all land on main. The audit's
    // detector only sees the HEAD:refs/heads/ spelling, so this contract
    // covers the other two explicitly.
    const source = readFileSync(path.join(repoRoot, 'crons', 'tuesday-code.sh'), 'utf8');
    const executed = source
      .split('\n')
      .map(stripComment)
      .filter((line) => line.trim().length > 0);
    for (const line of executed) {
      if (!/\bgit\s+push\b/.test(line)) continue;
      expect(line).not.toMatch(/\borigin\s+main\b/);
      expect(line).not.toMatch(/HEAD:main\b/);
      expect(line).not.toMatch(/refs\/heads\/main\b/);
    }
  });
});
