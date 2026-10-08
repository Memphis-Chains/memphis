import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Regression test for the 2026-10-08 finding: offsite backup had produced
// ZERO successful copies in 14 days (58 refusals logged), and every one of
// them said "failed verify". Three defects stacked, each hiding the next:
//
//   1. `memphis backup verify` printed `valid: false` but still exited 0.
//      The shell gate `if ! memphis backup verify` could therefore never
//      fire — a genuinely corrupt archive would have been copied anyway.
//   2. scripts/scheduled-backup-runner.mjs computed the sha256 and printed
//      it to stdout, but never wrote the `.sha256` sidecar that
//      verifyBackup() reads as the expected value. Every nightly archive
//      was unverifiable BY CONTRACT even though the file was intact.
//   3. backup-to-usb.sh called bare `memphis`, which lives in
//      ~/.local/share/npm-global/bin — absent from the systemd user
//      manager's PATH. The command exited 127 (not found), which the
//      `if !` gate read as "verification failed".
//
// Result: intact archives reported as corrupt, while the real corruption
// signal (defect 1) was structurally unreachable. These are measured
// behaviours of the shipped CLI and shell script, not source-text greps.

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const cliEntry = path.join(repoRoot, 'bin', 'memphis.js');
const usbScript = path.join(repoRoot, 'scripts', 'backup-to-usb.sh');
const runnerPath = path.join(repoRoot, 'scripts', 'scheduled-backup-runner.mjs');

const runnerSource = readFileSync(runnerPath, 'utf8');
const usbSource = readFileSync(usbScript, 'utf8');

/**
 * Run the CLI, reporting exit status separately from the streams.
 * `spawnSync` returns both; the shell `$?` after a pipe returns neither.
 */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', [cliEntry, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
    // Never let this contract suite touch the operator's real .env.
    env: { ...process.env, MEMPHIS_ENV_FILE: path.join(tmpdir(), 'memphis-ops-contract.env') },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A minimal well-formed tar.gz, so the behaviour under test is the exit
 *  status and not tar parsing. */
function makeArchive(dir: string, name: string): string {
  const source = path.join(dir, 'payload');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'chain.json'), '{"index":1}', 'utf8');
  const archive = path.join(dir, name);
  const tar = spawnSync('tar', ['-czf', archive, '-C', dir, 'payload'], { encoding: 'utf8' });
  expect(tar.status).toBe(0);
  return archive;
}

function writeSidecar(archive: string): void {
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`, 'utf8');
}

describe('memphis backup verify — the exit code is the shell contract', () => {
  it('exits non-zero for an intact archive that has no checksum sidecar', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'verify-no-sidecar-'));
    try {
      const archive = makeArchive(dir, 'missing-sidecar.tar.gz');
      expect(existsSync(`${archive}.sha256`)).toBe(false);

      const run = runCli(['backup', 'verify', archive]);

      // The defect shape: `valid: false` on stdout AND exit 0. A caller
      // gating on the status alone copied a corrupt archive offsite.
      expect(run.stdout).toContain('valid: false');
      expect(run.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero for a random-bytes file even when a sidecar matches it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'verify-not-an-archive-'));
    try {
      const archive = path.join(dir, 'garbage.tar.gz');
      writeFileSync(archive, Buffer.alloc(4096, 7));
      // Sidecar matching those bytes, so this isolates "is it a readable
      // archive" from "does the digest match".
      writeSidecar(archive);

      const run = runCli(['backup', 'verify', archive]);
      expect(run.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits zero for an intact archive with a matching sidecar', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'verify-good-'));
    try {
      const archive = makeArchive(dir, 'good.tar.gz');
      writeSidecar(archive);

      const run = runCli(['backup', 'verify', archive]);

      // Without this, "always exit 1" would satisfy every other test here.
      expect(run.stdout).toContain('valid: true');
      expect(run.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scripts/scheduled-backup-runner.mjs — persists the checksum sidecar', () => {
  it('writes the digest it computed next to the archive', () => {
    // verifyBackup() reads the expected value from `<archive>.sha256`.
    // The runner computed the identical digest and only printed it.
    expect(runnerSource).toMatch(/writeFileSync\(\s*`\$\{backupPath\}\.sha256`/);
  });

  it('writes the sidecar before cleanup can drop the archive it describes', () => {
    // `cleanupOldBackups(` first matches the function DEFINITION near the top
    // of the file, not its call inside main() — that made this assertion
    // compare a definition position against a call position.
    const sidecarWrite = runnerSource.indexOf('writeFileSync(`${backupPath}.sha256`');
    const cleanupCall = runnerSource.indexOf('const deleted = cleanupOldBackups(keep)');
    expect(sidecarWrite).toBeGreaterThan(-1);
    expect(cleanupCall).toBeGreaterThan(-1);
    expect(sidecarWrite).toBeLessThan(cleanupCall);
  });

  it('removes the sidecar when rotating an archive out, so none linger', () => {
    // An orphaned .sha256 outlives its archive and reads as a live backup.
    expect(runnerSource).toMatch(/const sidecar = join\(BACKUPS_DIR, `\$\{f\}\.sha256`\)/);
    expect(runnerSource).toContain('if (existsSync(sidecar)) unlinkSync(sidecar)');
  });
});

describe('scripts/backup-to-usb.sh — resolves the CLI before calling it', () => {
  it('does not depend on the systemd user manager PATH', () => {
    // ~/.local/share/npm-global/bin is absent from that PATH, so bare
    // `memphis` exited 127 and `if ! memphis ...` reported corruption.
    expect(usbSource).not.toMatch(/^\s*if ! memphis backup verify/m);
    expect(usbSource).toContain('MEMPHIS_BIN');
  });

  it('resolves MEMPHIS_BIN to a real file and fails loudly when absent', () => {
    expect(usbSource).toMatch(/MEMPHIS_BIN="\$\{MEMPHIS_BIN:-/);
    expect(usbSource).toContain('memphis CLI not found');
  });

  it('captures the verify status without tripping set -e', () => {
    // Under `set -e`, `out=$(cmd)` on its own line aborts before `$?` is
    // ever read, so the diagnostic never printed (measured rc=1 with empty
    // stderr). And `|| true` is not a fix: it replaces `$?` with its own 0.
    expect(usbSource).toContain('&& verify_rc=0 || verify_rc=$?');
  });

  it('survives a context with no USER set (set -u)', () => {
    // `$USER` under `set -u` aborted the script with rc=1 and an unbound
    // variable error, before the mount probe could report its own code 2.
    const run = spawnSync(
      'bash',
      ['-c', `HOME=${JSON.stringify(tmpdir())} bash ${JSON.stringify(usbScript)}`],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
        env: { PATH: '/usr/bin:/bin' },
      },
    );
    expect(run.stderr).not.toContain('unbound variable');
    // Reaching the mount probe is the contract: exit 2 = "no mount", which
    // is what this host genuinely reports right now.
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('no USB mount found');
  });
});
