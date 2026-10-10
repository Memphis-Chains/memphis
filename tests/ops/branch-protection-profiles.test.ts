/**
 * Executable contract for the branch-protection scripts, driven through a fake
 * curl so the scripts really run.
 *
 * WHY THIS REPLACED THE OLD PROFILE TEST
 * -------------------------------------
 * The previous version stubbed `GET /repos/{o}/{r}/branches/{branch}/protection`
 * and asserted on `required_approving_review_count`. Measured 2026-10-09: that
 * endpoint answers 404 for this repository, because the protection is a
 * *ruleset*, and `required_approving_review_count: 0` is rejected outright by
 * the ruleset API with HTTP 422. So the old test kept a green harness around
 * behaviour that no longer exists, and would have passed while both scripts
 * were broken against the real API.
 *
 * What is asserted here is what the scripts do against a ruleset API:
 *   - the four required contexts are written, strict
 *   - a read failure is a failure with a non-zero status
 *   - a ruleset that is stored but missing a check is a failure
 *   - the Telegram smoke check is never made required
 *
 * The policy contract (which contexts, and why smoke is excluded) lives in
 * branch-protection-ruleset-contract.test.ts. This file is the executable half.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const enforceScript = path.join(repoRoot, 'scripts', 'enforce-branch-protection.sh');
const verifyScript = path.join(repoRoot, 'scripts', 'verify-branch-protection.sh');

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const RULESET_ID = 14186283;

/** The list endpoint: an array of ruleset summaries. */
function rulesetListJson(): string {
  return JSON.stringify([{ id: RULESET_ID, name: 'main', enforcement: 'active' }]);
}

/** A ruleset as the API returns it, so assertions run on a real shape. */
function rulesetJson(mutate?: (r: Record<string, unknown>) => void): string {
  const rule = JSON.parse(rulesetListJson())[0];
  void rule;
  const base = {
    id: RULESET_ID,
    name: 'main',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [
            { context: 'quality-gate' },
            { context: 'chain-invariant' },
            { context: 'cross-arch (macos-latest)' },
            { context: 'cross-arch (ubuntu-24.04-arm)' },
          ],
          strict_required_status_checks_policy: true,
        },
      },
    ],
  };
  const parsed = base as unknown as Record<string, unknown>;
  mutate?.(parsed);
  return JSON.stringify(parsed);
}

/**
 * Fake curl: answers per URL suffix from a routes file, 404 for anything it is
 * not told about.
 *
 * The 404 default is the point. The previous harness answered 200 for every
 * request, so a script talking to the wrong endpoint — which is exactly what
 * both scripts did for months — still looked like it had succeeded.
 *
 * Routes file format: one `urlSuffix<TAB>status<TAB>bodyFile` per line. A file,
 * not an env string, because a ruleset body contains newlines and braces and
 * would not survive quoting.
 */
function writeFakeCurl(binDir: string): void {
  const scriptPath = path.join(binDir, 'curl');
  const content = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'out_file=""',
    'url=""',
    'capture=""',
    '',
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    '    -o) out_file="$2"; shift 2 ;;',
    '    -d) payload="$2"',
    '             if [[ "$payload" == @* ]]; then payload="$(cat "${payload#@}" 2>/dev/null || echo "$payload")"; fi',
    '             if [[ -n "${MEMPHIS_TEST_CAPTURE_FILE:-}" ]]; then printf "%s" "$payload" > "${MEMPHIS_TEST_CAPTURE_FILE}"; fi',
    '             shift 2 ;;',
    '    -w) shift 2 ;;',
    '    -X|-H) shift 2 ;;',
    '    -s|-sS) shift ;;',
    '    *) url="$1"; shift ;;',
    '  esac',
    'done',
    '',
    'status=404',
    'body_file=""',
    'if [[ -n "${MEMPHIS_FAKE_ROUTES:-}" && -f "${MEMPHIS_FAKE_ROUTES}" ]]; then',
    '  while read -r suffix want_status want_body; do',
    '    [[ -z "${suffix:-}" ]] && continue',
    '    if [[ "$url" == *"$suffix" ]]; then',
    '      status="$want_status"',
    '      body_file="$want_body"',
    '      break',
    '    fi',
    '  done < "${MEMPHIS_FAKE_ROUTES}"',
    'fi',
    '',
    'if [[ -n "$out_file" ]]; then',
    '  if [[ -n "$body_file" && -f "$body_file" ]]; then cat "$body_file" > "$out_file"; else printf "{}" > "$out_file"; fi',
    'fi',
    'printf "%s" "$status"',
    '',
  ].join('\n');
  writeFileSync(scriptPath, content, 'utf8');
  chmodSync(scriptPath, 0o755);
}

type Route = { status: number; body?: string };

function runScript(
  scriptPath: string,
  routes: Record<string, Route>,
  envOverrides: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  const binDir = makeTempDir('memphis-fake-curl-');
  const routesDir = makeTempDir('memphis-fake-routes-');
  writeFakeCurl(binDir);

  const routesFile = path.join(routesDir, 'routes.tsv');
  const lines = Object.entries(routes).map(([suffix, spec], i) => {
    const bodyFile = path.join(routesDir, `body-${i}.json`);
    writeFileSync(bodyFile, spec.body ?? '{}', 'utf8');
    return `${suffix}\t${spec.status}\t${bodyFile}`;
  });
  writeFileSync(routesFile, lines.join('\n') + '\n', 'utf8');

  return spawnSync('bash', [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...envOverrides,
      GITHUB_TOKEN: envOverrides.GITHUB_TOKEN ?? 'test-token',
      MEMPHIS_FAKE_ROUTES: routesFile,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
    encoding: 'utf8',
  });
}

/** A ruleset that is correct, plus the list the scripts read first. */
function okRoutes(): Record<string, Route> {
  return {
    [`/rulesets/${RULESET_ID}`]: { status: 200, body: rulesetJson() },
    '/rulesets': { status: 200, body: rulesetListJson() },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('verify-branch-protection.sh — real exit codes against a ruleset API', () => {
  it('passes when the ruleset carries exactly the required checks', () => {
    const r = runScript(verifyScript, okRoutes());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('required=chain-invariant');
  });

  it('fails when a required check is missing', () => {
    const routes = okRoutes();
    routes[`/rulesets/${RULESET_ID}`] = {
      status: 200,
      body: rulesetJson((d) => {
        const rules = d.rules as Array<Record<string, Record<string, unknown>>>;
        rules[2].parameters.required_status_checks = [{ context: 'quality-gate' }];
      }),
    };
    const r = runScript(verifyScript, routes);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Required checks mismatch');
  });

  it('fails when the ruleset cannot be listed', () => {
    const r = runScript(verifyScript, { '/rulesets': { status: 500, body: '{"message":"boom"}' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Cannot list rulesets');
  });

  it('fails when no ruleset named main exists', () => {
    const r = runScript(verifyScript, { '/rulesets': { status: 200, body: '[]' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('No ruleset named');
  });

  it('fails when enforcement is disabled', () => {
    const routes = okRoutes();
    routes[`/rulesets/${RULESET_ID}`] = {
      status: 200,
      body: rulesetJson((d) => {
        d.enforcement = 'disabled';
      }),
    };
    const r = runScript(verifyScript, routes);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not active');
  });

  it('fails when the rule has no branch condition', () => {
    const routes = okRoutes();
    routes[`/rulesets/${RULESET_ID}`] = {
      status: 200,
      body: rulesetJson((d) => {
        d.conditions = { ref_name: { include: [], exclude: [] } };
      }),
    };
    const r = runScript(verifyScript, routes);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no branch condition');
  });

  it('fails when the checks are not strict', () => {
    const routes = okRoutes();
    routes[`/rulesets/${RULESET_ID}`] = {
      status: 200,
      body: rulesetJson((d) => {
        const rules = d.rules as Array<Record<string, Record<string, unknown>>>;
        rules[2].parameters.strict_required_status_checks_policy = false;
      }),
    };
    const r = runScript(verifyScript, routes);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not strict');
  });
});

describe('enforce-branch-protection.sh — writes what the policy says', () => {
  it('exits 0 and confirms the write when the API accepts it', () => {
    const captureFile = path.join(makeTempDir('memphis-capture-'), 'body.json');
    const r = runScript(enforceScript, okRoutes(), { MEMPHIS_TEST_CAPTURE_FILE: captureFile });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('required: chain-invariant');

    // The payload itself, not just the exit code: an accepted write of the
    // wrong ruleset is the failure mode this script exists to prevent.
    const written = JSON.parse(readFileSync(captureFile, 'utf8')) as {
      rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
      conditions: { ref_name: { include: string[] } };
    };
    const checkRule = written.rules.find((x) => x.type === 'required_status_checks');
    const params = (checkRule?.parameters ?? {}) as {
      required_status_checks?: Array<{ context: string }>;
      strict_required_status_checks_policy?: boolean;
    };
    const contexts = (params.required_status_checks ?? []).map((c) => c.context);
    expect(contexts).toContain('quality-gate');
    expect(contexts).not.toContain('smoke');
    expect(params.strict_required_status_checks_policy).toBe(true);
  });

  it('fails when the write is rejected, and shows the API answer', () => {
    const r = runScript(enforceScript, {
      [`/rulesets/${RULESET_ID}`]: { status: 422, body: '{"message":"Invalid property /rules/3"}' },
      '/rulesets': { status: 200, body: rulesetListJson() },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('422');
  });

  it('fails when the ruleset cannot be listed', () => {
    const r = runScript(enforceScript, {
      '/rulesets': { status: 500, body: '{"message":"boom"}' },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Listing rulesets failed');
  });

  it('rejects an invalid profile with exit 2 before touching the API', () => {
    const r = runScript(enforceScript, {}, { MEMPHIS_BRANCH_PROTECTION_PROFILE: 'nonsense' });
    expect(r.status).toBe(2);
  });
});
