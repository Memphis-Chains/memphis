/**
 * main must actually be protected, and the check that says so must be able to
 * fail.
 *
 * WHAT WAS WRONG, MEASURED 2026-10-09
 * -----------------------------------
 * `verify-branch-protection.sh` read
 * GET /repos/{owner}/{repo}/branches/{branch}/protection, which answers 404
 * "Branch not protected" for this repository — the protection is a *ruleset*
 * named "main", not classic branch protection. It then printed the failure and
 * exited 0. Every other failure path in that function called `exit 1`; the 404
 * path did not. So the one script whose job is to detect an unprotected main
 * was reporting "no protection here" with a success status.
 *
 * And `enforce-branch-protection.sh` PUT to the same dead endpoint, so it could
 * never have applied anything. Nothing in CI ran either script.
 *
 * These assertions are about the source, not about GitHub's current state: the
 * live state is verified by running the scripts, which the operator does with
 * `npm run -s ops:verify-main-protection`. A test that called GitHub would be a
 * test that passes or fails for reasons outside the repo.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ENFORCE = resolve('scripts/enforce-branch-protection.sh');
const VERIFY = resolve('scripts/verify-branch-protection.sh');
const enforce = readFileSync(ENFORCE, 'utf8');
const verify = readFileSync(VERIFY, 'utf8');

/** The four contexts that must gate a merge. */
const REQUIRED = [
  'quality-gate',
  'chain-invariant',
  'cross-arch (macos-latest)',
  'cross-arch (ubuntu-24.04-arm)',
];

describe('branch protection scripts — use the interface that exists', () => {
  it('reads and writes rulesets, not the dead branch-protection endpoint', () => {
    // The endpoint below answers 404 for this repository. Measured, twice: once
    // with curl and once through the previous version of verify-branch-protection.sh.
    for (const [name, src] of [
      ['enforce', enforce],
      ['verify', verify],
    ]) {
      expect(src, `${name} must not use branches/{branch}/protection`).not.toContain(
        '/branches/${BRANCH}/protection',
      );
      expect(src).toContain('/rulesets');
    }
  });

  it('never reads a required check from a status it assumed', () => {
    // `~DEFAULT_BRANCH` is resolved by GitHub. A literal "main" would silently
    // stop applying if the default branch were renamed — which is exactly the
    // shape of the ruleset that was already in place, with an empty condition.
    expect(enforce).toContain('~DEFAULT_BRANCH');
  });
});

describe('verify-branch-protection.sh — a read failure must be a failure', () => {
  it('exits non-zero when the ruleset list cannot be read', () => {
    // The defect this file exists to prevent: a 404 printed as a failure and
    // returned as success. Any HTTP code other than 200 has to exit 1.
    expect(verify).toMatch(/\[\[ "\$code" == "200" \]\] \|\| \{/);
    expect(verify).toMatch(/Cannot list rulesets/);
    // ...and the exit must actually be non-zero, not a bare echo.
    const guard = verify.indexOf('Cannot list rulesets');
    expect(guard).toBeGreaterThan(-1);
    expect(verify.slice(guard, guard + 400)).toContain('exit 1');
  });

  it('exits non-zero when the ruleset is missing entirely', () => {
    expect(verify).toContain('fail "No ruleset named');
    expect(verify).toMatch(/^fail\(\) \{/m);
    // A `fail` that only echoes would be the same defect wearing a new hat.
    const fn = verify.slice(verify.indexOf('fail()'));
    expect(fn.slice(0, 200)).toContain('exit 1');
  });

  it('rejects a ruleset that is stored but does not apply', () => {
    // Empty include + exclude means "applies to nothing", which reads as a
    // configured rule and behaves as no rule at all. That is the state this
    // repository was actually in.
    expect(verify).toContain('has no branch condition');
    expect(verify).toContain('strict_required_status_checks_policy');
  });
});

describe('branch protection policy — what must and must not gate a merge', () => {
  it.each(REQUIRED)('requires %s', (context) => {
    expect(enforce).toContain(`{ context: "${context}" }`);
    expect(verify).toContain(context);
  });

  it('requires them strict, so a stale green run is not accepted', () => {
    expect(enforce).toContain('strict_required_status_checks_policy: true');
    expect(verify).toContain('Required checks are not strict');
  });

  it('does NOT require the Telegram smoke check', () => {
    // telegram-smoke.yml exits 78 when its secrets are absent, on purpose:
    // "skipped is not success", so a green row means a message was really sent.
    // As a required check it could never be green without secrets, and would
    // block every merge forever. It runs on its own schedule and stays advisory.
    expect(enforce).not.toContain('{ context: "smoke" }');
    // verify fails if someone adds it later.
    expect(verify).toContain('The Telegram smoke check is required');
  });

  it('writes no pull_request rule, because the API rejects one for solo use', () => {
    // Measured: HTTP 422 "Invalid property /rules/N" for
    // `required_approving_review_count: 0`, and `dismiss_stale_reviews_on_push`
    // is not on the ruleset schema at all — it is a repository setting.
    expect(enforce).not.toContain('"type": "pull_request"');
  });
});

describe('branch protection — the automerge path cannot bypass the gate', () => {
  const automerge = readFileSync(resolve('.github/workflows/automerge.yml'), 'utf8');

  it('goes through the action that shells out to gh pr merge --auto', () => {
    // Measured 2026-10-09: automerge.yml has 928 runs, every one `skipped`,
    // because the `automerge` label does not exist in this repository. So it is
    // a path that has never fired, not a path that let anything through — and
    // an earlier note in this repo claimed the opposite.
    //
    // The action runs `gh pr merge --auto`, which GitHub holds until the
    // required checks pass. With required_status_checks in place the label is a
    // request, not a permission.
    expect(automerge).toContain('enable-pull-request-automerge');
    expect(automerge).toContain("contains(github.event.pull_request.labels.*.name, 'automerge')");

    // ...and verify reports the path rather than staying quiet about it.
    expect(verify).toContain('automerge path');
  });

  it('verify fails if automerge ever uses --admin', () => {
    // --admin bypasses required checks. There is no version of that which is
    // safe while this script claims main is protected.
    expect(automerge).not.toContain('--admin');
    expect(verify).toContain('which bypasses required checks');
  });

  it('never greps for a literal the workflow does not contain', () => {
    // The first version checked for `--auto` in the workflow file. The workflow
    // uses the action, so that string never appears — the check matched nothing,
    // printed nothing, and passed. A gate that is green because its pattern
    // cannot fire is the same failure as the dead knip rule, in a new place.
    expect(verify).not.toMatch(/grep -q -- '--auto'/);
    expect(verify).toContain("grep -q 'enable-pull-request-automerge'");
  });
});

describe('required checks must actually run where they are required', () => {
  const ci = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const chain = readFileSync(resolve('.github/workflows/chain-invariant.yml'), 'utf8');

  /**
   * A required check that its workflow skips on the surface where it is
   * required is not a gate — it is a deadlock.
   *
   * Measured on PR #656, 2026-10-10: the `main` ruleset required
   * `cross-arch (macos-latest)` and `cross-arch (ubuntu-24.04-arm)`, and the
   * `cross-arch` job carried `if: github.event_name == 'push'`. On a pull
   * request the job was skipped, the required check never arrived, and the PR
   * sat at mergeStateStatus BLOCKED with chain-invariant and quality-gate both
   * green and nothing failing to fix.
   *
   * Every required context has to name a job that runs on `pull_request`. This
   * is the same failure shape as the knip rule that stayed green for weeks
   * because its pattern never matched.
   */

  /**
   * The block of a job, from its `name:` line to the next one, with comment
   * lines stripped.
   *
   * Stripping comments is not cosmetic: the first version matched on the raw
   * text and immediately flagged `quality-gate`, because the explanatory note
   * written about this very fix quotes `github.event_name == 'push'`. A guard
   * that reads its own documentation as configuration will fire forever.
   */
  function jobBlock(src: string, name: string): string {
    const at = src.indexOf(`\n  ${name}:\n`);
    if (at === -1) return '';
    const rest = src.slice(at + 1);
    const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    const block = next === -1 ? rest : rest.slice(0, next);
    return block
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
  }

  it('quality-gate is not gated to push-only', () => {
    const block = jobBlock(ci, 'quality-gate');
    expect(block, 'quality-gate job not found in ci.yml').not.toBe('');
    expect(block).not.toContain("github.event_name == 'push'");
  });

  it('chain-invariant is not gated to push-only', () => {
    const block = jobBlock(chain, 'chain-invariant');
    expect(block, 'chain-invariant job not found in chain-invariant.yml').not.toBe('');
    expect(block).not.toContain("github.event_name == 'push'");
    // And it must actually trigger on pull requests at all.
    expect(chain).toMatch(/pull_request:/);
  });

  it('cross-arch runs on pull requests, where arch bugs are cheapest to catch', () => {
    const block = jobBlock(ci, 'cross-arch');
    expect(block, 'cross-arch job not found in ci.yml').not.toBe('');
    // This is the exact line that deadlocked PR #656.
    expect(block).not.toContain("github.event_name == 'push'");
    expect(block).toContain('runs-on:');
    expect(ci).toContain('ubuntu-24.04-arm');
    expect(ci).toContain('macos-latest');
  });

  it('every workflow behind a required context triggers on pull_request', () => {
    // The same deadlock one level up: a required check in a workflow that never
    // runs on PRs never arrives.
    for (const [file, src] of [
      ['ci.yml', ci],
      ['chain-invariant.yml', chain],
    ] as const) {
      expect(src, `${file} has no pull_request trigger`).toMatch(/pull_request:/);
    }
  });
});

describe('branch protection scripts — read HTTP status where it was written', () => {
  it('never runs an API call inside a pipeline', () => {
    // Three measured failures: appending the status after the body on stdout
    // (jq parsed the trailing "200"), then a variable set inside a helper
    // called from a pipeline (the body is a subshell and cannot export upward),
    // then a global set inside the same helper. All three reported
    // "unknown" or crashed on a request that had actually returned 200.
    for (const [name, src] of [
      ['enforce', enforce],
      ['verify', verify],
    ]) {
      expect(src, `${name} must not pipe a curl call`).not.toMatch(/= "\$\(curl/);
      expect(src).toContain("-w '%{http_code}'");
    }
  });

  it('checks the status code, not only curl success', () => {
    // curl exits 0 on a 404. Reading only its exit code is how the old verify
    // script called a failed request a success.
    expect(enforce).toMatch(/require_2xx/);
    expect(verify).toMatch(/\[\[ "\$code" == "200" \]\]/);
  });
});

describe('branch protection scripts — are runnable', () => {
  it.each([
    ['enforce', ENFORCE],
    ['verify', VERIFY],
  ])('%s passes bash -n', (_name, path) => {
    expect(() => execFileSync('bash', ['-n', path], { encoding: 'utf8' })).not.toThrow();
  });

  it('verify refuses to run without a token instead of reporting success', () => {
    // A verification script that proceeds without credentials can only produce
    // a false negative, and a false "OK" is worse than no check.
    //
    // The refusal is exit 2 with the message on stderr, so this catches the
    // exception rather than reading stdout: the first version used execFileSync
    // without a try and failed with "Command failed" — which was the script
    // behaving correctly, and the test asserting the wrong channel.
    let message = '';
    let status: number | undefined;
    try {
      execFileSync('bash', [VERIFY], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, GITHUB_TOKEN: '', GH_TOKEN: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      status = 0;
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      status = err.status;
      message = err.stderr ?? '';
    }
    expect(status).toBe(2);
    expect(message).toContain('Missing token');
  });
});
