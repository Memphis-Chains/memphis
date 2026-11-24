/**
 * The gate between the two writers of archives and the index of archives.
 *
 * WHY THIS IS ITS OWN TEST
 *
 * Two writers publish archives (`memphis backup create` and the systemd
 * runner `scripts/scheduled-backup-runner.mjs`) and two writers delete them.
 * Until the index of archives — the manifest — had one implementation, each
 * writer kept its own idea of what it should contain, and the two drifted
 * apart in BOTH directions.
 *
 * Measured 2026-11-22 on this host (`~/.memphis/backups`): 27 archives on
 * disk, 53 manifest entries. 30 of the entries pointed at files that had
 * been gone for weeks, and 4 of the archives on disk had no entry at all —
 * including the four newest scheduled ones, so the tag a command like
 * `backup clean --tag scheduled` filters on was not the one the operator
 * chose.
 *
 * The archives on disk are the truth; the manifest is an index of them. So
 * the index is reconciled with the disk on every write, and both writers go
 * through the same module (`scripts/backup-manifest.mjs`).
 *
 * The runner is driven here as a subprocess, in a temporary data directory,
 * so what is asserted is what the systemd timer actually does — not what a
 * copy of the runner would do.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as manifestModule from '../../scripts/backup-manifest.mjs';
import {
  deriveTagFromFileName,
  readManifest,
  reconcileManifest,
} from '../../scripts/backup-manifest.mjs';
import * as manifestBridge from '../../src/infra/cli/commands/backup-manifest.js';
import { createBackup } from '../../src/infra/cli/commands/backup.js';

vi.mock('../../src/infra/auth/operator-gate.js', () => ({
  requireOperatorAuth: vi.fn(async () => true),
}));

const runner = join(process.cwd(), 'scripts/scheduled-backup-runner.mjs');

let root: string;
let state: string;
let repo: string;
let backups: string;

function runRunner(extra: string[] = []) {
  return spawnSync(process.execPath, [runner, '--data-dir', state, '--repo-root', repo, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: '' },
  });
}

function manifestEntries(): Array<{ file: string; tag: string }> {
  return readManifest(backups).backups.map((entry) => ({
    file: entry.file,
    tag: entry.tag,
  }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memphis-manifest-test-'));
  state = join(root, 'state');
  repo = join(root, 'repo');
  backups = join(state, 'backups');
  mkdirSync(join(state, 'chains'), { recursive: true });
  mkdirSync(join(repo, 'data'), { recursive: true });
  mkdirSync(backups, { recursive: true });
  writeFileSync(join(state, 'chains/journal-000001.json'), '{"fixture":"chain-data"}');
  vi.stubEnv('MEMPHIS_ENV_FILE', join(root, 'absent.env'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('the manifest is one index of the archives on disk', () => {
  it('re-exports every runtime export of the shared module', () => {
    // A hand-maintained export list is how the two writers silently drift:
    // adding a function to the module left it unreachable from the CLI until
    // tsc failed. Reported as one list, so a missing name is named.
    const runtimeExports = Object.keys(manifestModule).filter((name) => name !== 'default');
    const bridged = new Set(Object.keys(manifestBridge));
    expect(runtimeExports.filter((name) => !bridged.has(name))).toEqual([]);
    expect(runtimeExports.length).toBeGreaterThan(0);
  });

  it('takes the tag from the name in front of the timestamp', () => {
    // The two writers put two different timestamp shapes at the end of an
    // archive name. Counting fields fitted only the CLI's shape, so every
    // runner archive came out tagged `scheduled-2026` — a tag no command
    // names. Measured against every archive on this host: this rule
    // reproduces the manifest's own tag for all 23 archives that have one.
    expect(deriveTagFromFileName('scheduled-2026-11-22-11-42.tar.gz')).toBe('scheduled');
    expect(deriveTagFromFileName('scheduled-2026-11-22_11-42-30-5599.tar.gz')).toBe('scheduled');
    expect(deriveTagFromFileName('pre-tier2-operator-2026-11-09-09-20.tar.gz')).toBe(
      'pre-tier2-operator',
    );
    expect(
      deriveTagFromFileName('before-basal-audit-schema-repair-2026-10-29-18-13.tar.gz'),
    ).toBe('before-basal-audit-schema-repair');
    expect(deriveTagFromFileName('pre-basal-decision-2026-10-27-2026-10-27-21-55.tar.gz')).toBe(
      'pre-basal-decision-2026-10-27',
    );
  });

  it('records the archive the runner publishes', () => {
    const result = runRunner();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);

    const entries = manifestEntries();
    expect(entries.map((entry) => entry.file)).toContain(report.file);
    // The tag the operator chose, not a guess from the filename.
    expect(entries.find((entry) => entry.file === report.file)?.tag).toBe('scheduled');
  });

  it('forgets the archive the runner retires', () => {
    const first = runRunner();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const firstFile = JSON.parse(first.stdout).file;

    const second = runRunner(['--keep', '1']);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    const secondFile = JSON.parse(second.stdout).file;

    // Retention removed the older archive. The index must not keep a ghost
    // for it: on this host the manifest had 30 such ghosts.
    expect(existsSync(join(backups, firstFile))).toBe(false);
    const entries = manifestEntries();
    expect(entries.map((entry) => entry.file)).not.toContain(firstFile);
    expect(entries.map((entry) => entry.file)).toEqual([secondFile]);
  });

  it('the CLI and the runner keep the same index', async () => {
    const result = runRunner();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const runnerFile = JSON.parse(result.stdout).file;

    const created = await createBackup({
      memphisRoot: state,
      showProgress: false,
    });

    const entries = manifestEntries();
    expect(entries.map((entry) => entry.file).sort()).toEqual(
      [runnerFile, created.file].sort(),
    );
    // Same shape, one index — the CLI's entry and the runner's entry are
    // read by the same code.
    const manifest = readManifest(backups);
    for (const entry of manifest.backups) {
      expect(Object.keys(entry).sort()).toEqual([
        'checksum',
        'file',
        'fileCount',
        'size',
        'tag',
        'timestamp',
      ]);
    }
  });

  it('an archive on disk with no entry enters the index, and a ghost leaves it', () => {
    const archive = 'pre-tier2-operator-2026-11-09-09-20.tar.gz';
    writeFileSync(join(backups, archive), 'synthetic archive', 'utf8');
    writeFileSync(
      join(backups, 'manifest.json'),
      JSON.stringify({
        backups: [
          {
            file: 'scheduled-2000-01-01-00-00.tar.gz',
            tag: 'scheduled',
            timestamp: '2000-01-01T00:00:00.000Z',
            size: 1,
            checksum: 'sha256:synthetic',
            fileCount: 1,
          },
        ],
        retentionPolicy: { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 },
      }),
      'utf8',
    );

    const reconciled = reconcileManifest(backups);

    expect(reconciled.changed).toBe(true);
    expect(reconciled.manifest.backups.map((entry) => entry.file)).toEqual([archive]);
    // The tag comes from the name, so the entry is usable by a scoped clean.
    expect(reconciled.manifest.backups[0].tag).toBe('pre-tier2-operator');
    // The ghost is gone from the file too, not just from memory.
    const onDisk = JSON.parse(readFileSync(join(backups, 'manifest.json'), 'utf8')) as {
      backups: Array<{ file: string }>;
    };
    expect(onDisk.backups.map((entry) => entry.file)).toEqual([archive]);
  });

  it('a partial archive is never an archive', () => {
    writeFileSync(join(backups, 'scheduled-2026-11-22-11-42.tar.gz.partial'), 'in flight');
    const reconciled = reconcileManifest(backups);
    expect(reconciled.manifest.backups).toEqual([]);
    expect(
      readdirSync(backups).filter((file) => file.endsWith('.tar.gz')),
    ).toEqual([]);
  });
});
