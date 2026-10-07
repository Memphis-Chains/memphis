import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * scripts/dep-audit.sh is the single implementation behind both
 * .github/workflows/ci.yml and scripts/nightly-crystal-pass.sh.
 *
 * It existed before this file as two copies that disagreed: ci.yml ran an
 * audited jq filter with a one-advisory allowlist, nightly ran a bare
 * `npm audit --omit=dev --audit-level=high` with none. Nightly then failed
 * every night while ci stayed green — and pii-scan.sh and secret-scan.sh
 * lived inside that permanently red check, which is how a security gate
 * ends up in a job nobody reads.
 *
 * These tests pin the three contract branches against a synthetic audit
 * payload. `npm audit` against the live tree is not used: the point is the
 * policy, not whatever version happens to be installed today, and a test
 * that depends on the registry cannot tell a policy regression from a new
 * advisory.
 */

const SCRIPT = resolve('scripts/dep-audit.sh');

const CRITICAL_PAYLOAD = JSON.stringify({
  metadata: { vulnerabilities: { critical: 1, high: 0, moderate: 0 } },
  vulnerabilities: {
    'some-pkg': {
      severity: 'critical',
      via: [{ url: 'https://github.com/advisories/GHSA-cr1t-ical-0001' }],
    },
  },
});

const UNALLOWED_HIGH_PAYLOAD = JSON.stringify({
  metadata: { vulnerabilities: { critical: 0, high: 1, moderate: 0 } },
  vulnerabilities: {
    'other-pkg': {
      severity: 'high',
      via: [{ url: 'https://github.com/advisories/GHSA-h1gh-0ther-0002' }],
    },
  },
});

const ALLOWLISTED_HIGH_PAYLOAD = JSON.stringify({
  metadata: { vulnerabilities: { critical: 0, high: 1, moderate: 2 } },
  vulnerabilities: {
    '@opentelemetry/exporter-prometheus': {
      severity: 'high',
      via: [{ url: 'https://github.com/advisories/GHSA-q7rr-3cgh-j5r3' }],
    },
  },
});

/**
 * Run the script with `npm audit` replaced by a fixture. Substituting in a
 * temp copy keeps the script itself untouched — a test that edits the
 * source it is testing can pass while the source is broken.
 */
function auditWith(payload: string): { status: number; stdout: string; stderr: string } {
  const original = readFileSync(SCRIPT, 'utf8');
  const fixture = join(process.cwd(), '.dep-audit-fixture.json');
  writeFileSync(fixture, payload, 'utf8');
  try {
    const patched = original.replace(
      'audit_json="$(npm audit --omit=dev --json 2>/dev/null || true)"',
      `audit_json="$(cat ${fixture})"`,
    );
    expect(patched, 'failed to substitute the npm audit call in dep-audit.sh').not.toBe(original);

    const dir = resolve('.tmp-dep-audit');
    const script = join(dir, 'dep-audit.sh');
    writeFileSync(script, patched, 'utf8');
    const out = spawnSync('bash', [script], { encoding: 'utf8' });
    return { status: out.status ?? 1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  } finally {
    execFileSync('rm', ['-f', fixture]);
  }
}

beforeAll(() => {
  execFileSync('mkdir', ['-p', resolve('.tmp-dep-audit')]);
});

afterAll(() => {
  execFileSync('rm', ['-rf', resolve('.tmp-dep-audit'), resolve('.dep-audit-fixture.json')]);
});

describe('scripts/dep-audit.sh — advisory policy', () => {
  it('fails unconditionally on a critical advisory', () => {
    const r = auditWith(CRITICAL_PAYLOAD);
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('critical vulnerabilities');
  });

  it('fails on a high advisory that is not allowlisted', () => {
    const r = auditWith(UNALLOWED_HIGH_PAYLOAD);
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('Unallowed high advisories');
  });

  it('passes when every high advisory is allowlisted', () => {
    const r = auditWith(ALLOWLISTED_HIGH_PAYLOAD);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('allowlisted: GHSA-q7rr-3cgh-j5r3');
  });

  it('records the reason for each allowlisted advisory next to the entry', () => {
    // An allowlist entry without a stated reason becomes an unexamined
    // exception within a few releases. The reason is the part that is
    // reviewed; assert it is still there.
    const src = readFileSync(SCRIPT, 'utf8');
    // Last occurrence, not first: the header comment also names the
    // advisory when explaining what moved into this file. Asserting on
    // `indexOf` checked the wrong comment and failed for the right reason
    // at the wrong place.
    const idx = src.lastIndexOf('GHSA-q7rr-3cgh-j5r3');
    expect(idx, 'allowlist entry missing from dep-audit.sh').toBeGreaterThan(-1);
    const context = src.slice(Math.max(0, idx - 700), idx);
    expect(context).toMatch(/opt-in|operator decision|declined/i);
  });
});
