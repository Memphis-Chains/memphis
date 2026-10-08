import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

/**
 * Keeps the chain-shape gate inside CI.
 *
 * The sweep fix (`chains_scanned` counted directories, so a chain that
 * lost every block still exited 0) landed with tests that ran locally
 * but never in the workflow: chain-invariant.yml invoked exactly one
 * file. On 2026-10-07 that gap mattered — 176 of 177 hourly sweeps
 * reported 14 chains, one reported 3 with `ok: true`, and nothing in CI
 * was watching the distinction.
 *
 * These assertions are deliberately about the WORKFLOW, not the sweep:
 * a correct test suite that no job invokes protects nothing.
 */
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'chain-invariant.yml');

interface Step {
  name?: string;
  run?: string;
  if?: string;
}

function runSteps(): Step[] {
  const parsed = YAML.parse(readFileSync(workflowPath, 'utf8')) as {
    jobs?: Record<string, { steps?: Step[] }>;
  };
  const job = parsed.jobs?.['chain-invariant'];
  if (!job) throw new Error('chain-invariant.yml has no `chain-invariant` job');
  return job.steps ?? [];
}

function vitestCommand(): string {
  const step = runSteps().find((s) => s.run?.includes('vitest'));
  if (!step) throw new Error('chain-invariant.yml no longer runs vitest');
  return step.run!;
}

describe('chain-invariant CI gate covers the sweep shape contract', () => {
  it('runs the shape suite, not just the fixtures pass', () => {
    const run = vitestCommand();

    expect(run).toContain('tests/integration/chain-invariant.test.ts');
    expect(run).toContain('tests/integration/chain-sweep-shape.test.ts');
  });

  it('fails the job when the shape suite fails', () => {
    // A `continue-on-error` or a per-file `|| true` would restore the
    // exact gap this file exists to close.
    const step = runSteps().find((s) => s.run?.includes('vitest'));
    expect(step?.run).not.toContain('|| true');
    expect(step?.run).not.toContain('continue-on-error');
    // No `if:` at all is the correct state; an absent field must not throw.
    expect(step?.if ?? '').not.toContain('always()');
  });

  it('runs on push as well as pull requests', () => {
    // The regression appeared on main (19:00 sweep), not on a PR. A
    // pull_request-only trigger cannot catch a shape that changes under
    // the operator's feet.
    const parsed = YAML.parse(readFileSync(workflowPath, 'utf8')) as {
      on?: Record<string, unknown>;
    };
    const triggers = Object.keys(parsed.on ?? {});

    expect(triggers).toContain('push');
    expect(triggers).toContain('pull_request');
    expect(triggers).toContain('schedule');
    expect(triggers).toContain('workflow_dispatch');
  });

  it('scopes the push trigger to main', () => {
    // Every push to a fork branch would add a redundant run; the gate
    // exists for what lands on main.
    const parsed = YAML.parse(readFileSync(workflowPath, 'utf8')) as {
      on?: { push?: { branches?: string[] } };
    };
    expect(parsed.on?.push?.branches).toEqual(['main']);
  });
});
