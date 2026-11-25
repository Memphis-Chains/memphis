/**
 * THE GATE between the tar rule and its two callers.
 *
 * WHY THIS IS ITS OWN TEST
 *
 * Two runners publish archives: the compiled CLI (`memphis backup create`,
 * which the runtime calls from inside its own event loop) and the plain-Node
 * systemd runner (`scripts/scheduled-backup-runner.mjs`). Before this module
 * each of them called `tar` on its own and classified tar's failures on its
 * own, and the classifications had already drifted: the CLI grew a "file
 * changed as we read it" rule and a "tar's stderr in the operator's message"
 * rule, while the runner re-implemented the first one inline and dropped the
 * second.
 *
 * The rule itself lives in `scripts/backup-tar.mjs` — one implementation, two
 * runners, and one artefact of cases. This file holds that artefact:
 *
 *   - the bridge re-exports every runtime export (a hand-maintained list is
 *     how the two writers drift, and `tsc` only catches it when the CLI
 *     happens to use the new name);
 *   - the two runners produce the SAME archive from the same tree, so "one
 *     rule" is a fact about the archives and not about the source;
 *   - a tar failure still NAMES the reason, because "Command failed: tar"
 *     with nothing after it is what three consecutive nightly backups
 *     reported on this host (2026-11-23, 24, 25);
 *   - nothing in the archive path waits on a child process synchronously.
 *
 * The behavioural half of this rule — that the archive path keeps the event
 * loop turning — is in `tests/integration/backup-event-loop.test.ts`, because
 * a gate that only reads source cannot tell a busy loop from a stuck one.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as tarModule from '../../scripts/backup-tar.mjs';
import {
  describeTarFailure,
  isTarExecutionError,
  isTarFileChangedWarning,
} from '../../scripts/backup-tar.mjs';
import * as tarBridge from '../../src/infra/cli/commands/backup-tar.js';
import { createBackup, listArchiveContents } from '../../src/infra/cli/commands/backup.js';

vi.mock('../../src/infra/auth/operator-gate.js', () => ({
  requireOperatorAuth: vi.fn(async () => true),
}));

const runner = join(process.cwd(), 'scripts/scheduled-backup-runner.mjs');

let root: string;
let state: string;
let repo: string;

function runRunner(extra: string[] = []) {
  return spawnSync(process.execPath, [runner, '--data-dir', state, '--repo-root', repo, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: '' },
  });
}

/** The members of an archive, read the way both runners read them. */
async function membersOf(archivePath: string): Promise<string[]> {
  return (await listArchiveContents(archivePath)).map((entry) => entry.replace(/^\.\//, '')).sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memphis-tar-contract-'));
  state = join(root, 'state');
  repo = join(root, 'repo');
  mkdirSync(join(state, 'chains', 'journal'), { recursive: true });
  mkdirSync(join(repo, 'data'), { recursive: true });
  writeFileSync(join(state, 'chains', 'journal', '000001.json'), '{"fixture":"chain-data"}');
  writeFileSync(join(state, 'notes.txt'), 'operator notes');
  vi.stubEnv('MEMPHIS_ENV_FILE', join(root, 'absent.env'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('the tar rule has one owner and two runners', () => {
  it('re-exports every runtime export of the shared module', () => {
    // A hand-maintained export list is how the two writers silently drift:
    // adding a function to the module left it unreachable from the CLI until
    // tsc failed. Reported as one list, so a missing name is named.
    const runtimeExports = Object.keys(tarModule).filter((name) => name !== 'default');
    const bridged = new Set(Object.keys(tarBridge));
    expect(runtimeExports.filter((name) => !bridged.has(name))).toEqual([]);
    expect(runtimeExports.length).toBeGreaterThan(0);
  });

  it('the CLI and the runner produce the same archive from the same tree', async () => {
    const result = runRunner();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const runnerArchive = JSON.parse(result.stdout).path;
    expect(existsSync(runnerArchive)).toBe(true);

    const created = await createBackup({ memphisRoot: state, showProgress: false });

    // The same members, in the same order — not "both archives exist".
    expect(await membersOf(created.backupPath)).toEqual(await membersOf(runnerArchive));
  }, 60_000);

  it('a tar failure names the reason instead of the command alone', () => {
    // "Command failed: tar -xzf …" and nothing else is what three
    // consecutive nightly backups reported on this host: the reason (no space
    // left on device, a killed process, a corrupt member) was thrown away.
    const failure = new Error('Command failed: tar -xzf /archive.tar.gz -C /scratch');
    (failure as unknown as { stderr: string }).stderr =
      'tar: /scratch/file: Cannot write: No space left on device';

    const described = describeTarFailure(failure);
    expect(described.message).toContain('No space left on device');
    expect(described.message).toContain('Command failed: tar');
  });

  it('tells "tar could not start" from "tar warned about a file that changed"', () => {
    const missing = Object.assign(new Error('spawn tar ENOENT'), { code: 'ENOENT' });
    expect(isTarExecutionError(missing)).toBe(true);
    expect(isTarFileChangedWarning(missing, '/nonexistent')).toBe(false);

    // tar's own exit code 1 with the file-changed signature, and an archive
    // that IS on disk: the archive is usable, and the caller may keep it.
    const warned = Object.assign(new Error('Command failed: tar'), {
      status: 1,
      stderr: 'tar: .: file changed as we read it',
    });
    const archive = join(root, 'partial-but-readable.tar.gz');
    writeFileSync(archive, 'bytes', 'utf8');
    expect(isTarFileChangedWarning(warned, archive)).toBe(true);
    // …and the same warning without an archive on disk is NOT a pass.
    expect(isTarFileChangedWarning(warned, join(root, 'absent.tar.gz'))).toBe(false);
    // A different exit code is a real failure, not a warning.
    expect(
      isTarFileChangedWarning(
        Object.assign(new Error('x'), { status: 2, stderr: warned.stderr }),
        archive,
      ),
    ).toBe(false);
  });

  it('no part of the archive path waits on a child process synchronously', () => {
    // The freeze this rule exists to prevent was a SYNCHRONOUS child
    // process: `execFileSync`/`spawnSync` hold the runtime's event loop for
    // the length of the call, and a signal handler cannot run while the loop
    // is asleep. Measured on this host: 11 302 ms of silence inside one
    // drill, and a stop signal that was never answered.
    //
    // The behavioural half of this gate is
    // `tests/integration/backup-event-loop.test.ts`; this half names the
    // files the rule covers, so a new synchronous call cannot be added
    // without this test saying so.
    const covered = [
      'scripts/backup-tar.mjs',
      'scripts/backup-db-snapshot.mjs',
      'scripts/scheduled-backup-runner.mjs',
      'src/infra/cli/commands/backup.ts',
    ];
    for (const file of covered) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      const offenders = source
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /\b(execFileSync|spawnSync|execSync)\s*\(/.test(line))
        .filter(({ line }) => !/^\s*(\*|\/\/)/.test(line));
      expect(offenders, `${file} calls a child process synchronously`).toEqual([]);
    }
  });
});
