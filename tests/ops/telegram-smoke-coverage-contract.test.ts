import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

/**
 * A CI job that skips every real step and still reports `success` is worse
 * than no job: the run list says the thing works.
 *
 * Evidence (2026-10-07): run 37735415527 `Telegram smoke test` = success,
 * while the operator's own box reported `telegram: state=missing-token`.
 * Cause: every step after the secret check is guarded by
 * `if: steps.check-secrets.outputs.skipped != 'true'`, so with no secrets
 * the job executed zero real steps and exited 0.
 *
 * The fix is a final step that turns "skipped" into the job's actual
 * outcome (exit 78, EX_CONFIG). This test keeps that from being reverted
 * by someone who reads the guards as "already handled".
 */
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'telegram-smoke.yml');

interface Step {
  name?: string;
  if?: string;
  run?: string;
}

interface Job {
  steps?: Step[];
}

function smokeJob(): Job {
  const parsed = YAML.parse(readFileSync(workflowPath, 'utf8')) as { jobs?: Record<string, Job> };
  const job = parsed.jobs?.smoke;
  if (!job) throw new Error('telegram-smoke.yml has no `smoke` job');
  return job;
}

describe('telegram-smoke workflow reports real coverage', () => {
  it('has a final step that fails the job when the smoke test is skipped', () => {
    const steps = smokeJob().steps ?? [];
    const coverage = steps.find((s) => s.name?.includes('Report coverage'));

    expect(coverage, 'a coverage-reporting step must exist').toBeDefined();
    // `always()` so it also runs when an earlier step failed — otherwise a
    // real failure would be masked as "skipped".
    expect(coverage?.if).toContain('always()');
    expect(coverage?.run).toContain('exit 78');
    expect(coverage?.run).toContain('::notice');
  });

  it('guards every networked step behind the secrets check', () => {
    const steps = smokeJob().steps ?? [];
    // install / build / the live API call. If any of these loses its
    // guard, a missing secret turns into a confusing CI error instead of
    // a clean skip.
    const networked = steps.filter((s) =>
      /npm ci|npm run build|telegram smoke-test/.test(s.run ?? ''),
    );

    expect(networked.length).toBeGreaterThan(0);
    for (const step of networked) {
      expect(step.if, `step "${step.name}" must be guarded`).toContain("skipped != 'true'");
    }
  });

  it('does not let the smoke job gate another workflow', () => {
    // exit 78 must stay harmless: nothing may depend on this workflow, or
    // a missing secret would turn into a red main branch.
    const parsed = YAML.parse(readFileSync(workflowPath, 'utf8')) as {
      jobs?: Record<string, { needs?: string[] }>;
    };
    expect(Object.keys(parsed.jobs ?? {})).toEqual(['smoke']);
  });
});
