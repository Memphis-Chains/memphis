import { execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realTmpdir } from '../helpers/tmpdir.js';

/**
 * scripts/secret-scan.sh covers an expanding set of credential prefixes.
 * This test stages a synthetic file containing each pattern in a fresh
 * tmpdir and asserts the scan flags it (exit 1). Issue #274 added the
 * OpenAI/Stripe families on 2026-04-30; if a downstream contributor
 * tightens the regex too far we want to catch the regression here.
 */

const SCRIPT_PATH = resolve('scripts/secret-scan.sh');

interface ExecError extends Error {
  status: number | null;
  stdout?: Buffer;
  stderr?: Buffer;
}

function runScan(cwd: string): SpawnSyncReturns<Buffer> {
  // Use spawnSync via execFileSync wrapper that returns full result on
  // failure. execFileSync throws on non-zero exit, but we need to read
  // the exit code regardless.
  try {
    const stdout = execFileSync('bash', [SCRIPT_PATH], { cwd, stdio: 'pipe' });
    return { status: 0, stdout, stderr: Buffer.from(''), output: [], pid: 0, signal: null };
  } catch (err) {
    const e = err as ExecError;
    return {
      status: e.status ?? 1,
      stdout: e.stdout ?? Buffer.from(''),
      stderr: e.stderr ?? Buffer.from(''),
      output: [],
      pid: 0,
      signal: null,
    };
  }
}

describe('scripts/secret-scan.sh — credential prefix detection', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(realTmpdir(), 'memphis-secret-scan-'));
    // Stage a minimal package.json so the scan thinks it's at a project
    // root (avoids walking up); we only care about whether the regex
    // matches the file we plant, not directory traversal semantics.
    writeFileSync(join(dir, 'package.json'), '{}');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Each fixture is a (label, sample-string) pair. Sample is the
  // representative shape of that credential family — concatenated at
  // runtime from short literal pieces so this test file itself does
  // not contain anything that GitHub Push Protection / secret scanners
  // (or our own scanner!) will flag as a real-looking secret. The
  // scanner regex matches the runtime-concatenated string just fine.
  const SK = 'sk';
  const RK = 'rk';
  const SKHYPHEN = `${SK}-`;
  const SKUNDER = `${SK}_`;
  const RKUNDER = `${RK}_`;
  const RANDLOOKING_LONG = 'abcdefghijklmnopqrstuvwxyz1234567890';
  const RANDLOOKING_24 = 'aBcDeFgHiJkLmNoPqRsTuVwX';
  const fixtures: Array<[string, string]> = [
    ['aws-access-key', `AKIA${'ABCDEF1234567890'}`],
    ['gcp-api-key', `AIza${'SyABCdefghijklmnopqrstuvwxyz123456789'}`],
    ['github-pat', `ghp_${RANDLOOKING_LONG}`],
    ['anthropic-key (legacy sk-ant-)', `${SKHYPHEN}ant-api03_${RANDLOOKING_LONG.slice(0, 26)}`],
    ['openai-key admin scope (#274 Codex P1)', `${SKHYPHEN}admin-${RANDLOOKING_LONG}`],
    ['openai-key proj scope (#274)', `${SKHYPHEN}proj-${RANDLOOKING_LONG}`],
    ['openai-key live scope (#274)', `${SKHYPHEN}live-${RANDLOOKING_LONG}`],
    ['openai-key None scope (#274)', `${SKHYPHEN}None-${RANDLOOKING_LONG}`],
    ['stripe sk_live (#274)', `${SKUNDER}live_${RANDLOOKING_24}`],
    ['stripe rk_test (#274)', `${RKUNDER}test_${RANDLOOKING_24}`],
    ['stripe webhook whsec_ (#274)', `whsec_${RANDLOOKING_24}YZ012345`],
    ['slack token xoxb-', `xoxb-12345-abcdefgh-${'ABCDEFGH1234567890ab'}`],
    ['pem private key block', '-----BEGIN ' + 'RSA PRIVATE KEY-----'],
    ['api_key= assignment', `api_key="${RANDLOOKING_LONG.slice(0, 22)}"`],
  ];

  for (const [label, sample] of fixtures) {
    it(`flags a file containing a ${label}`, () => {
      writeFileSync(join(dir, 'fixture.env'), sample);
      const result = runScan(dir);
      expect(result.status).toBe(1);
      const stdout = result.stdout.toString('utf8');
      expect(stdout).toContain('fixture.env');
    });
  }

  it('passes a clean tree with no credential patterns', () => {
    writeFileSync(join(dir, 'README.md'), '# Memphis test fixture — no secrets here.\n');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const ok = true;\n');
    const result = runScan(dir);
    expect(result.status).toBe(0);
    expect(result.stdout.toString('utf8')).toContain('OK');
  });
});
