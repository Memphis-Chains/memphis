import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realTmpdir } from '../helpers/tmpdir.js';

/**
 * scripts/pii-scan.sh guards the operator's account identifiers against
 * being committed to a PUBLIC repo. This test exists because the original
 * guard silently failed: 68780a7 scrubbed the identifier from the tree and
 * added .gitignore entries to prevent recurrence, then ed2f1f4 committed
 * the same real value again three days later under new filenames, and
 * secret-scan.sh reported `OK` the whole time because an account id matches
 * no credential prefix.
 *
 * Each fixture below plants a real-shaped leak in a fresh tmpdir and asserts
 * the scan flags it. A test that only asserts the scan passes is worth
 * nothing here — a scanner that matches nothing passes forever, which is
 * exactly how the original guard died.
 */

const SCRIPT_PATH = resolve('scripts/pii-scan.sh');

interface ScanResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runScan(cwd: string, args: string[] = []): ScanResult {
  // spawnSync, not execFileSync: the script writes its findings to stderr,
  // and execFileSync hands stderr to the parent process instead of
  // capturing it — which made two assertions below read '' and fail for a
  // reason that had nothing to do with the scanner.
  const r = spawnSync('bash', [SCRIPT_PATH, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

const GIT_ENV = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

function commitAll(dir: string): void {
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', [...GIT_ENV, 'commit', '-q', '-m', 'x'], { cwd: dir });
}

describe('scripts/pii-scan.sh — operator identifier detection', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(realTmpdir(), 'memphis-pii-scan-'));
    // A git repo is mandatory: the scanner reads `git ls-files`, not the
    // filesystem. Without this it exits 0 as "not a git repository" and
    // every assertion below would pass for the wrong reason.
    spawnSync('git', ['init', '-q'], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function commitLeak(name: string, body: string): ScanResult {
    // mkdir the parent: two tests plant nested paths, and a missing
    // directory surfaces as ENOENT, which reads like a scanner failure
    // and is not one.
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body, 'utf8');
    commitAll(dir);
    return runScan(dir);
  }

  // Assembled at runtime, never written literally: the scan under test
  // reads this very file once it is tracked, and a literal id here would
  // make the scanner block its own test — correctly, and uselessly.
  const OPERATOR_ID = ['131', '603', '3647'].join('');
  const NEUTRAL_FIXTURE = '99999999';

  it('blocks the operator chat id in a tracked file', () => {
    const result = commitLeak('leak.env', `MEMPHIS_TELEGRAM_CHAT_ID=${OPERATOR_ID}\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BLOCK');
    expect(result.stderr).toContain('leak.env');
  });

  // The regression that actually happened: the value arrived in a test
  // fixture whose name no .gitignore rule mentions. If this passes only
  // for a path the scanner special-cases, it is not measuring the guard.
  it('blocks the identifier in a test fixture under an unrelated name', () => {
    const result = commitLeak(
      'tests/unit/mcp-send-chatid.test.ts',
      `const CHAT_ID = '${OPERATOR_ID}';\n`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BLOCK');
  });

  it('blocks the identifier once committed, even after the file is renamed', () => {
    commitLeak('a.env', `CHAT=${OPERATOR_ID}\n`);
    spawnSync('git', ['mv', 'a.env', 'b.env'], { cwd: dir });
    const result = runScan(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('b.env');
  });

  it('passes a tracked tree containing only the neutral fixture', () => {
    const result = commitLeak('fixture.env', `MEMPHIS_TELEGRAM_CHAT_ID=${NEUTRAL_FIXTURE}\n`);
    expect(result.status).toBe(0);
  });

  it('ignores the identifier in an untracked file', () => {
    // Scope is deliberately `git ls-files`. A local .env backup full of
    // real ids is a separate audit, not this gate — see the script header.
    writeFileSync(join(dir, 'scratch.env'), `CHAT=${OPERATOR_ID}\n`, 'utf8');
    writeFileSync(join(dir, 'tracked.txt'), 'hello\n', 'utf8');
    // `git add tracked.txt`, NOT `add -A`: staging everything would make
    // scratch.env tracked and the assertion vacuous.
    spawnSync('git', ['add', 'tracked.txt'], { cwd: dir });
    spawnSync('git', [...GIT_ENV, 'commit', '-q', '-m', 'x'], { cwd: dir });
    const result = runScan(dir);
    expect(result.status).toBe(0);
  });

  // The script's header names the very patterns it searches for, so a naive
  // implementation flags its own source. Copying it into a tmpdir keeps the
  // assertion honest without scanning the real 2000-file repo, which costs
  // ~17s and pushes this file against the 30s suite timeout.
  // The gate's first version read file bodies only. Measured consequence:
  // `dsmx-usa-assets/dsmx-usa-promo-30s-canam-polaris.mp4` — 3.8 MB of a
  // named client's promo video — sat on the public default branch for
  // seven months while the scan reported OK, because the identifier was
  // in the *filename*. Path scanning is the other half of the contract.
  it('blocks an operator identifier in a tracked filename', () => {
    const result = commitLeak(`account/session-${OPERATOR_ID}.json`, '{ "redacted": true }\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BLOCK');
  });

  it('blocks a tracked .htpasswd even though its content carries no operator id', () => {
    // The real leak from 2026-10-09: a password hash on a public branch.
    // No value arm can catch this (the hash is not the operator's id), no
    // name arm can catch it (.htpasswd is innocuous), and secret-scan.sh
    // looks for credential headers that an htpasswd line does not have.
    const result = commitLeak('secrets/.htpasswd', 'memphis:$2y$10$abcdefghijklmnopqrstuv\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BLOCK');
    expect(result.stderr).toContain('.htpasswd');
  });

  it('blocks a tracked private key file by type, not by content', () => {
    // A binary-looking key body with no PEM header: content arms see nothing,
    // the type arm sees `id_ed25519.key`.
    const result = commitLeak('keys/id_ed25519.key', '\x00\x01\x02opaque-key-bytes\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.key');
  });

  it('blocks every credential-material extension, not just htpasswd', () => {
    for (const name of ['a.pem', 'b.p12', 'c.pfx', 'd.jks', 'e.keystore', 'f.kdbx', 'g.age']) {
      const result = commitLeak(`creds/${name}`, 'opaque\n');
      expect(result.status, `${name} should be blocked`).toBe(1);
      expect(result.stderr).toContain(name);
    }
  });

  it('does not block a tracked file whose name merely mentions the extension', () => {
    // `.key` mid-name (deployment.key-map.json) is not a key file; a pattern
    // anchored only on a substring would block it forever and get disabled.
    const result = commitLeak('config/deployment.key-map.json', '{"note":"no secret here"}\n');
    expect(result.status).toBe(0);
  });

  it('reports a third-party identifier in a filename as advisory', () => {
    // Must use a name the script actually denies. An invented
    // 'client-brand' directory asserted nothing — the scan correctly did
    // not flag a string it has no rule for, and the test failed for a
    // reason unrelated to the guard.
    const result = commitLeak('dsmx-brand/logo.png', 'not really a png\n');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('ADVISORY');
  });

  it('does not flag itself, whose header names the patterns it searches for', () => {
    spawnSync('mkdir', ['-p', join(dir, 'scripts')], { cwd: dir });
    copyFileSync(SCRIPT_PATH, join(dir, 'scripts/pii-scan.sh'));
    commitAll(dir);
    const result = runScan(dir);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('BLOCK');
  });

  it('reports third-party identifiers as advisory by default', () => {
    const result = commitLeak('note.md', 'Client shop: dsmxshop.com\n');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('ADVISORY');
  });

  it('escalates advisory identifiers to a failure under --strict', () => {
    const result = commitLeak('note.md', 'Client shop: dsmxshop.com\n');
    expect(runScan(dir, ['--strict']).status).toBe(1);
    expect(result.status).toBe(0);
  });
});
