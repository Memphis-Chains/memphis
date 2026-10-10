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
import { readdirSync, readFileSync } from 'node:fs';
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

    it('names workflows that exist, not the checks they produce', () => {
      // `workflow_run.workflows` takes WORKFLOW names. `quality-gate` and
      // `cross-arch (macos-latest)` are job names inside `ci`. Listing them makes
      // GitHub reject the whole file without warning: the workflow stops being
      // registered, vanishes from the API, and every trigger goes silent. That is
      // what happened on 2026-10-10 — PR #665 got no automerge run at all, and
      // the cause was a name that looked entirely plausible.
      const real = new Set<string>();
      for (const file of readdirSync(resolve('.github/workflows'))) {
        if (!/\.ya?ml$/.test(file)) continue;
        const other = parseYaml(readFileSync(resolve('.github/workflows', file), 'utf8')) as {
          name?: string;
        };
        if (other?.name) real.add(other.name);
      }
      const triggers = (doc as { on: Record<string, { workflows?: string[] }> }).on;
      const listed = triggers.workflow_run?.workflows ?? [];
      expect(listed.length).toBeGreaterThan(0);
      for (const name of listed) {
        expect(real, `workflow_run names "${name}", which is not a workflow`).toContain(name);
      }
    });

    it('covers both workflows behind the required checks', () => {
      // quality-gate and both cross-arch contexts come from `ci`; chain-invariant
      // comes from its own workflow. Missing either means the second door never
      // opens when that check is the last to finish.
      const triggers = (doc as { on: Record<string, { workflows?: string[] }> }).on;
      const listed = new Set(triggers.workflow_run?.workflows ?? []);
      for (const w of ['ci', 'chain-invariant']) expect(listed).toContain(w);
    });

    it('refuses a failed or non-success upstream run', () => {
      // The job-level `if` has to close the second door the same way the first
      // door is closed for drafts.
      expect(wf).toContain("github.event_name == 'workflow_run'");
      expect(wf).toContain("github.event.workflow_run.conclusion == 'success'");
      expect(wf).toContain('github.event.pull_request.draft == false');
    });

    it('passes the PR number through env, not into the script body', () => {
      // `${{ }}` inside a run block is expanded before bash runs. It works, and
      // it makes the step impossible to execute outside Actions.
      const runs = (wf.match(/run: \|[\s\S]*?(?=\n\s{0,6}[a-z-]+:|\n\n)/g) ?? []).join('\n');
      expect(runs).not.toContain('${{');
    });
  });
});
