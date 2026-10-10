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
      expect(wf).toContain('pull_request_target');
      expect(wf).toContain('workflow_run');
      expect(wf).toContain('types: [completed]');
    });

    it('wakes on the pull request head, not on a commit on main', () => {
      // Measured on PR #669. `workflow_run` fired four times with
      // `head_branch=main` and a `head_sha` pointing at the MERGE commit, so
      // "which PRs contain this commit" correctly answered none and the job
      // stopped every time while a green PR sat open. `check_run` carries the
      // commit that was actually checked.
      const triggers = (doc as { on: Record<string, unknown> }).on;
      expect(triggers.workflow_run).toBeUndefined();
      expect(triggers.check_run).toBeDefined();
      const wf = doc.jobs.automerge as unknown as Record<string, unknown>;
      expect(wf).toBeTruthy();
    });

    it('ignores a check_run that ran against the merge commit', () => {
      // `main`'s own quality-gate and chain-invariant runs complete constantly.
      // Treating those as a verdict would make the job look for a PR at every
      // post-merge pipeline run on main.
      const jobIf = doc.jobs.automerge.if ?? '';
      expect(jobIf).toContain("github.event.check_run.head_branch != 'main'");
      expect(jobIf).toContain("github.event.check_run.conclusion == 'success'");
    });

    it('refuses a check_run that did not succeed', () => {
      // The verdict must come from the check that finished, not from optimism.
      const jobIf = doc.jobs.automerge.if ?? '';
      expect(jobIf).toContain("github.event.check_run.conclusion == 'success'");
      expect(jobIf).toContain('github.event.pull_request.draft == false');
      expect(jobIf.match(/github\.event_name != 'check_run'/g) ?? []).toHaveLength(3);
    });

    it('passes the PR number through env, not into the script body', () => {
      // `${{ }}` inside a run block is expanded before bash runs. It works, and
      // it makes the step impossible to execute outside Actions.
      const runs = (wf.match(/run: \|[\s\S]*?(?=\n\s{0,6}[a-z-]+:|\n\n)/g) ?? []).join('\n');
      expect(runs).not.toContain('${{');
    });
  });
});
