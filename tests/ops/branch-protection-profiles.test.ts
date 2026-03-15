import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const fixturesDir = path.join(repoRoot, 'tests', 'fixtures', 'branch-protection');
const enforceScript = path.join(repoRoot, 'scripts', 'enforce-branch-protection.sh');
const verifyScript = path.join(repoRoot, 'scripts', 'verify-branch-protection.sh');

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFakeCurl(binDir: string): void {
  const scriptPath = path.join(binDir, 'curl');
  const content = `#!/usr/bin/env bash
set -euo pipefail

out_file=""
payload=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      out_file="$2"
      shift 2
      ;;
    -d)
      payload="$2"
      shift 2
      ;;
    -w)
      shift 2
      ;;
    -X|-H)
      shift 2
      ;;
    -s|-sS)
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -n "\${MEMPHIS_TEST_CURL_CAPTURE_BODY_FILE:-}" ]]; then
  printf '%s' "$payload" > "\${MEMPHIS_TEST_CURL_CAPTURE_BODY_FILE}"
fi

if [[ -n "$out_file" ]]; then
  if [[ -n "\${MEMPHIS_TEST_CURL_BODY_FILE:-}" ]]; then
    cat "\${MEMPHIS_TEST_CURL_BODY_FILE}" > "$out_file"
  else
    printf '{}' > "$out_file"
  fi
fi

printf '%s' "\${MEMPHIS_TEST_CURL_STATUS:-200}"
`;
  writeFileSync(scriptPath, content, 'utf8');
  chmodSync(scriptPath, 0o755);
}

function runScript(
  scriptPath: string,
  envOverrides: Record<string, string>,
): ReturnType<typeof spawnSync> {
  const binDir = makeTempDir('memphis-fake-curl-');
  writeFakeCurl(binDir);
  return spawnSync('bash', [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...envOverrides,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
    encoding: 'utf8',
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('branch protection profile scripts', () => {
  it('enforce script emits team payload with required reviews=1', () => {
    const captureFile = path.join(makeTempDir('memphis-capture-'), 'payload.json');
    const result = runScript(enforceScript, {
      GITHUB_TOKEN: 'test-token',
      MEMPHIS_BRANCH_PROTECTION_PROFILE: 'team',
      MEMPHIS_TEST_CURL_STATUS: '200',
      MEMPHIS_TEST_CURL_BODY_FILE: path.join(fixturesDir, 'protection-team.json'),
      MEMPHIS_TEST_CURL_CAPTURE_BODY_FILE: captureFile,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('profile=team');

    const payload = JSON.parse(readFileSync(captureFile, 'utf8'));
    expect(payload.required_pull_request_reviews.required_approving_review_count).toBe(1);
    expect(payload.required_status_checks.contexts).toContain('quality-gate');
  });

  it('enforce script emits solo payload with required reviews=0', () => {
    const captureFile = path.join(makeTempDir('memphis-capture-'), 'payload.json');
    const result = runScript(enforceScript, {
      GITHUB_TOKEN: 'test-token',
      MEMPHIS_BRANCH_PROTECTION_PROFILE: 'solo',
      MEMPHIS_TEST_CURL_STATUS: '200',
      MEMPHIS_TEST_CURL_BODY_FILE: path.join(fixturesDir, 'protection-solo.json'),
      MEMPHIS_TEST_CURL_CAPTURE_BODY_FILE: captureFile,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('profile=solo');

    const payload = JSON.parse(readFileSync(captureFile, 'utf8'));
    expect(payload.required_pull_request_reviews.required_approving_review_count).toBe(0);
    expect(payload.required_status_checks.contexts).toContain('quality-gate');
  });

  it('verify script passes with team fixture under team profile', () => {
    const result = runScript(verifyScript, {
      GITHUB_TOKEN: 'test-token',
      MEMPHIS_BRANCH_PROTECTION_PROFILE: 'team',
      MEMPHIS_TEST_CURL_STATUS: '200',
      MEMPHIS_TEST_CURL_BODY_FILE: path.join(fixturesDir, 'protection-team.json'),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('profile=team');
  });

  it('verify script passes with solo fixture under solo profile', () => {
    const result = runScript(verifyScript, {
      GITHUB_TOKEN: 'test-token',
      MEMPHIS_BRANCH_PROTECTION_PROFILE: 'solo',
      MEMPHIS_TEST_CURL_STATUS: '200',
      MEMPHIS_TEST_CURL_BODY_FILE: path.join(fixturesDir, 'protection-solo.json'),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('profile=solo');
  });

  it('verify script fails when fixture review count mismatches profile', () => {
    const result = runScript(verifyScript, {
      GITHUB_TOKEN: 'test-token',
      MEMPHIS_BRANCH_PROTECTION_PROFILE: 'solo',
      MEMPHIS_TEST_CURL_STATUS: '200',
      MEMPHIS_TEST_CURL_BODY_FILE: path.join(fixturesDir, 'protection-team.json'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Required review count mismatch');
    expect(result.stderr).toContain('expected=0 actual=1');
  });

  it('enforce script fails on github API 401 response', () => {
    const result = runScript(enforceScript, {
      GITHUB_TOKEN: 'test-token',
      MEMPHIS_BRANCH_PROTECTION_PROFILE: 'team',
      MEMPHIS_TEST_CURL_STATUS: '401',
      MEMPHIS_TEST_CURL_BODY_FILE: path.join(fixturesDir, 'error-401.json'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Failed (HTTP 401)');
    expect(result.stderr).toContain('Bad credentials');
  });

  it('verify script fails when quality-gate context is missing', () => {
    const result = runScript(verifyScript, {
      GITHUB_TOKEN: 'test-token',
      MEMPHIS_BRANCH_PROTECTION_PROFILE: 'team',
      MEMPHIS_TEST_CURL_STATUS: '200',
      MEMPHIS_TEST_CURL_BODY_FILE: path.join(fixturesDir, 'protection-missing-quality-gate.json'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing required status check: quality-gate');
  });

  it('verify script fails on policy mismatch', () => {
    const result = runScript(verifyScript, {
      GITHUB_TOKEN: 'test-token',
      MEMPHIS_BRANCH_PROTECTION_PROFILE: 'team',
      MEMPHIS_TEST_CURL_STATUS: '200',
      MEMPHIS_TEST_CURL_BODY_FILE: path.join(fixturesDir, 'protection-policy-mismatch.json'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Policy mismatch');
  });

  it('enforce script exits with code 2 on invalid profile value', () => {
    const result = runScript(enforceScript, {
      GITHUB_TOKEN: 'test-token',
      MEMPHIS_BRANCH_PROTECTION_PROFILE: 'invalid-profile',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid MEMPHIS_BRANCH_PROTECTION_PROFILE');
  });

  it('verify script exits with code 2 on invalid profile value', () => {
    const result = runScript(verifyScript, {
      GITHUB_TOKEN: 'test-token',
      MEMPHIS_BRANCH_PROTECTION_PROFILE: 'invalid-profile',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid MEMPHIS_BRANCH_PROTECTION_PROFILE');
  });
});
