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

const wf = readFileSync(resolve('.github/workflows/automerge.yml'), 'utf8');

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

  it('refuses to merge when the ruleset cannot be read', () => {
    // Guessing an empty list would mean "nothing is required", which merges
    // everything — the exact failure this replaces.
    expect(wf).toContain('No active required checks');
    expect(wf).toContain('refusing to auto-merge');
  });

  it('reads the active ruleset only', () => {
    expect(wf).toContain('enforcement');
    expect(wf).toContain('select($e == "active")');
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
});
