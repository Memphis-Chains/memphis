/**
 * automerge must merge on evidence, not on a label nobody uses.
 *
 * WHAT WAS WRONG, MEASURED 2026-10-10
 * ------------------------------------
 * The previous automerge.yml gated on:
 *
 *     contains(github.event.pull_request.labels.*.name, 'automerge')
 *
 * Measured against this repository: the label `automerge` does not exist, and no
 * pull request has ever carried it — zero, across the whole history. PRs #656
 * and #657 merged without it, taking 29 and 11 minutes from open to merge.
 *
 * So the workflow had never fired. It read as protection and provided none: a
 * gate nobody triggers is a comment. It also referenced no check status, so
 * even if the label existed it would have expressed nothing about whether the
 * code was verified.
 *
 * These assertions read the workflow as text. The decision logic is exercised
 * for real in automerge-decision.test.ts, which runs the extracted script
 * against a fake `gh` and checks all-green, one-failing and one-pending.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const wf = readFileSync(resolve('.github/workflows/automerge.yml'), 'utf8');
// Parsed once, so structural assertions can look at steps and triggers
// instead of at text that comments also occupy.
const doc = parseYaml(wf) as {
  on: Record<string, unknown>;
  jobs: { automerge: { if?: string; steps: Array<{ uses?: string; run?: string }> } };
};

function stepsScript(needle: string): string {
  const doc = parseYaml(wf) as {
    jobs: { automerge: { steps: Array<{ name?: string; run?: string }> } };
  };
  const hit = doc.jobs.automerge.steps.find(
    (s) => (s.name ?? '').toLowerCase().includes(needle) && s.run,
  );
  return hit?.run ?? '';
}

describe('automerge — triggers on state, not on a label', () => {
  it('does not gate on the automerge label', () => {
    // The label does not exist in this repository and no PR has carried it.
    expect(wf).not.toContain('contains(github.event.pull_request.labels');
    expect(wf).not.toContain("'automerge'");
  });

  it('still refuses drafts', () => {
    expect(wf).toContain('github.event.pull_request.draft == false');
  });

  it('runs on the events that can change a check result', () => {
    // `synchronize` is the one that matters: a new push invalidates the checks
    // the merge decision was based on.
    for (const trigger of ['opened', 'reopened', 'synchronize', 'ready_for_review']) {
      expect(wf).toContain(trigger);
    }
  });
});

describe('automerge — required checks come from the ruleset', () => {
  it('reads them from the API instead of hardcoding a list', () => {
    // A hardcoded list is a second place that can go stale, the same way a
    // hand-maintained metric drifts from the thing it measures.
    expect(wf).toContain('/rulesets');
    expect(wf).toContain('required_status_checks');
    expect(wf).not.toMatch(/context:\s*['"]quality-gate['"]/);
  });

  it('refuses to merge when the required checks cannot be read', () => {
    // Guessing an empty list would mean "nothing is required", which merges
    // everything — the exact failure this replaces.
    expect(wf).toContain('No required status checks configured');
    expect(wf).toContain('refusing to auto-merge');
  });

  it('reads branch rules, not the ruleset metadata list', () => {
    // `/rulesets` returns entries with no `rules` key at all. Reading `.rules[]?`
    // from it yields nothing and the `?` swallows that, so the step reported an
    // empty policy while four checks were configured — 928 runs, every one
    // skipped. The endpoint is the fix; this asserts it cannot silently regress.
    expect(wf).toContain('/rules/branches/');
    // Assert against the executed shell only. A blanket `not.toContain` over the
    // file also matches the comment that explains this bug — the same shape as
    // a grep that reports its own test fixture.
    const executed = wf
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    expect(executed).not.toMatch(/api=.*\/rulesets"/);
    expect(executed).not.toContain('.rules[]?');
  });
});

describe('automerge — a check is not green until it is green', () => {
  it('requires an explicit success', () => {
    // pending, skipped, failure and a missing check all read as "not yet".
    expect(wf).toContain('!= "success"');
    expect(wf).toContain('Not merging');
  });

  it('treats a check with no conclusion as missing, not as a pass', () => {
    // `[0] // "missing"` — without the fallback, jq returns nothing, the shell
    // sees an empty string, and an empty string is also "not success", so this
    // reads as belt and braces. It is the fallback that makes the intent
    // explicit for the next reader.
    // The YAML carries the jq expression with escaped quotes, so match the
    // escaped form an earlier assertion missed and reported a clean workflow as
    // broken.
    expect(wf).toContain('missing');
    expect(wf).toContain('.conclusion][0]');
  });

  it('iterates every required context rather than a hardcoded subset', () => {
    expect(wf).toContain("IFS=',' read -ra contexts");
    expect(wf).toMatch(/for ctx in "\$\{contexts\[@\]\}"/);
  });
});

describe('automerge — it merges, and only by squash', () => {
  it('merges with --squash explicitly', () => {
    // The ruleset permits squash only. Naming it here means the intent is
    // visible where the decision is made.
    expect(wf).toContain('gh pr merge');
    expect(wf).toContain('--squash');
  });

  it('has the permissions the merge needs', () => {
    expect(wf).toContain('contents: write');
    expect(wf).toContain('pull-requests: write');
  });

  describe('automerge — the write token must never touch pull request code', () => {
    it('never checks out anything', () => {
      // This job holds contents:write and pull-requests:write. Both triggers run
      // from the base branch, so the only thing that can execute is what is
      // already merged. A checkout of the PR head would make this job an
      // arbitrary-code-execution hole for anyone who can open a pull request.
      // Inspect the parsed steps, not the file text. A comment in the workflow
      // explains this exact rule, and a text search reports the explanation as
      // the violation.
      const steps = (doc as { jobs: { automerge: { steps: Array<{ uses?: string }> } } }).jobs
        .automerge.steps;
      const checkouts = steps.filter((st) => (st.uses ?? '').includes('actions/checkout'));
      expect(checkouts).toEqual([]);
    });

    it('waits for the checks instead of evaluating them once', () => {
      // `pull_request_target` alone fires while the checks are still running, so
      // the job reads "missing", refuses, and nothing wakes it afterwards. That
      // is why it never merged: PR #663 sat green and open until merged by hand.
      // The two event-driven alternatives were both measured and both dead on
      // this repository, so the retry is a schedule rather than a completion
      // event: `workflow_run` carries the merge commit, `check_run` never fires
      // for check suites GitHub created itself. `schedule` has no payload to be
      // wrong about. See "retries on a schedule" for the numbers.
      // Read the parsed triggers, not the file text: this file's own comments
      // name both dead triggers, and a text search reports the explanation as
      // the configuration. `workflow_dispatch` is deliberate — every scheduled
      // workflow here that has ever fired carries one, and it also gives the
      // operator a way to run the merge decision by hand.
      const triggers = (doc as { on: Record<string, unknown> }).on;
      expect(Object.keys(triggers).sort()).toEqual([
        'pull_request_target',
        'schedule',
        'workflow_dispatch',
      ]);
    });

    it('retries on a schedule instead of trusting a completion event', () => {
      // Measured on PR #669, with the checks green the whole time:
      //   workflow_run  fired 4x with head_branch=main and a merge-commit
      //                 head_sha, so "which PR contains this commit" answered
      //                 none every time;
      //   check_run    fired 0x — GitHub omits it for check suites it created
      //                 itself, which is all of them here.
      // Neither can be the second door. The schedule re-reads the checks.
      const triggers = (
        doc as {
          on: Record<string, Array<{ cron?: string }> | undefined>;
        }
      ).on;
      expect(triggers.workflow_run).toBeUndefined();
      expect(triggers.check_run).toBeUndefined();
      expect(triggers.pull_request_target).toBeDefined();
      expect(triggers.schedule?.[0]?.cron ?? '').not.toBe('');
    });

    it('polls often enough to be useful', () => {
      // The schedule IS the merge path, so its interval is the merge latency.
      // Every 5 minutes is the finest granularity that does not burn the free
      // minutes quota; slower than this and a green PR waits visibly.
      const triggers = (
        doc as {
          on: Record<string, Array<{ cron?: string }> | undefined>;
        }
      ).on;
      const entry = triggers.schedule?.[0]?.cron ?? '';
      const minutes = entry.split(' ')[0]?.split(',').map(Number).filter(Number.isInteger);
      expect(minutes?.length ?? 0).toBeGreaterThan(0);
      for (let i = 1; i < (minutes?.length ?? 0); i++) {
        const gap = minutes[i] - minutes[i - 1];
        expect(gap).toBeLessThanOrEqual(5);
      }
    });

    it('takes the newest open PR on the retry path', () => {
      // Oldest-first would leave the newest PR waiting behind every older one,
      // so the retry would pass over the PR that was just fixed.
      const resolve = stepsScript('resolve');
      expect(resolve).toContain('sort_by(.number) | last');
      // `state` is filtered here, not only in the query string. `?state=open`
      // is an API-side filter; if the endpoint ever returns something else, the
      // step must not pick up a closed PR and try to merge it.
      expect(resolve).toContain('select(.state == "open" and .draft == false)');
    });

    it('runs on a schedule, where there is no pull request to check', () => {
      // On `schedule` `github.event.pull_request` is null. A job-level `if` that
      // dereferences it is an error, not a false, and the retry — the only run
      // that can actually merge — would be skipped every time. The schedule arm
      // has to come first for that reason, not for tidiness.
      const cond = doc.jobs.automerge.if ?? '';
      expect(cond).toContain("github.event_name == 'schedule'");
      const scheduleAt = cond.indexOf("github.event_name == 'schedule'");
      const draftAt = cond.indexOf('github.event.pull_request.draft');
      expect(scheduleAt).toBeGreaterThanOrEqual(0);
      expect(draftAt).toBeGreaterThan(scheduleAt);
    });

    it('still refuses drafts', () => {
      expect(doc.jobs.automerge.if ?? '').toContain('github.event.pull_request.draft == false');
    });

    it('passes the PR number through env, not into the script body', () => {
      // `${{ }}` inside a run block is expanded before bash runs. It works, and
      // it makes the step impossible to execute outside Actions.
      const runs = (wf.match(/run: \|[\s\S]*?(?=\n\s{0,6}[a-z-]+:|\n\n)/g) ?? []).join('\n');
      expect(runs).not.toContain('${{');
    });
  });
});
