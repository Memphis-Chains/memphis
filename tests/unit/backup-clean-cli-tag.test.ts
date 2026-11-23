/**
 * The gate between the retention the operator asked for and the retention the
 * CLI performed.
 *
 * WHY THIS IS ITS OWN TEST
 *
 * `memphis backup clean --keep 7 --tag scheduled` is the documented command.
 * The parser reads `--tag`, `create` forwards it, and `clean` did not — so the
 * flag was parsed, advertised, and then dropped on the floor. `cleanBackups()`
 * treats a missing tag as "every class of archive".
 *
 * Measured 2026-11-22 on this host against the real backup directory
 * (`~/.memphis/backups`, 27 archives: 7 `scheduled` + 20 manual
 * pre-repair recovery points):
 *
 *   - the command as documented would have removed 20 archives and kept 7;
 *   - all 20 it would have removed were the MANUAL recovery points;
 *   - all 7 it would have kept were the scheduled ones.
 *
 * That is the exact inversion of the operator's intent, and the archives it
 * would have destroyed are the only path back from a botched restore. The
 * library function was never wrong — `tests/unit/scheduler-v2-hardening.test.ts`
 * already proved `cleanBackups({tag})` leaves a manual archive alone. The gap
 * was the WIRING, and a library-level test cannot see wiring.
 *
 * So this gate drives the real handler, through the real parser, against a
 * temporary data directory, and asserts on the filesystem.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/infra/auth/operator-gate.js', () => ({
  requireOperatorAuth: vi.fn(async () => true),
}));

import { handleBackupCommand } from '../../src/infra/cli/commands/backup.js';
import { createCliContext } from '../../src/infra/cli/context.js';
import { parseCommand } from '../../src/infra/cli/parser.js';

type Archive = {
  file: string;
  tag: string;
  timestamp: string;
};

const NEWEST_SCHEDULED = 'scheduled-2026-11-22-11-42.tar.gz';
const OLDER_SCHEDULED = 'scheduled-2026-11-21-02-04.tar.gz';
const MANUAL_RECOVERY_POINT = 'pre-tier2-operator-2026-11-09-09-20.tar.gz';

const ARCHIVES: Archive[] = [
  { file: NEWEST_SCHEDULED, tag: 'scheduled', timestamp: '2026-11-22T11:42:00.000Z' },
  { file: OLDER_SCHEDULED, tag: 'scheduled', timestamp: '2026-11-21T02:04:00.000Z' },
  { file: MANUAL_RECOVERY_POINT, tag: 'pre-tier2-operator', timestamp: '2026-11-09T09:20:00.000Z' },
];

let root: string;
let backupsRoot: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memphis-backup-clean-'));
  backupsRoot = join(root, 'backups');
  mkdirSync(backupsRoot, { recursive: true });
  previousDataDir = process.env.MEMPHIS_DATA_DIR;
  process.env.MEMPHIS_DATA_DIR = root;

  for (const archive of ARCHIVES) {
    writeFileSync(join(backupsRoot, archive.file), 'synthetic archive', 'utf8');
  }
  writeFileSync(
    join(backupsRoot, 'manifest.json'),
    JSON.stringify(
      {
        backups: ARCHIVES.map((archive) => ({
          file: archive.file,
          tag: archive.tag,
          timestamp: archive.timestamp,
          size: 17,
          checksum: 'sha256:synthetic',
          fileCount: 1,
        })),
        retentionPolicy: { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 },
      },
      null,
      2,
    ),
    'utf8',
  );
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.MEMPHIS_DATA_DIR;
  else process.env.MEMPHIS_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runClean(...flags: string[]): Promise<{ wouldRemove: string[]; removed: string[] }> {
  const argv = ['node', 'memphis', 'backup', 'clean', ...flags, '--json'];
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  });

  await handleBackupCommand(createCliContext(argv, parseCommand(argv)));

  const payload = JSON.parse(lines.join('\n')) as { wouldRemove: string[]; removed: string[] };
  return payload;
}

describe('backup clean honours the scope the operator asked for', () => {
  it('removes only the archives of the named tag', async () => {
    await runClean('--keep', '1', '--tag', 'scheduled');

    expect(existsSync(join(backupsRoot, NEWEST_SCHEDULED))).toBe(true);
    expect(existsSync(join(backupsRoot, OLDER_SCHEDULED))).toBe(false);
    // The falsifier: without the tag reaching the library, the manual
    // recovery point is deleted as well — it is one of the 20 the
    // documented command would have destroyed on this host.
    expect(
      existsSync(join(backupsRoot, MANUAL_RECOVERY_POINT)),
      'a manual recovery point is the only path back from a botched restore — a scoped clean must not touch it',
    ).toBe(true);
  });

  it('drops the manifest entry of every archive it removed', async () => {
    await runClean('--keep', '1', '--tag', 'scheduled');

    const manifest = JSON.parse(
      (await import('node:fs')).readFileSync(join(backupsRoot, 'manifest.json'), 'utf8'),
    ) as { backups: Array<{ file: string }> };

    expect(manifest.backups.map((entry) => entry.file)).not.toContain(OLDER_SCHEDULED);
    expect(manifest.backups.map((entry) => entry.file)).toContain(MANUAL_RECOVERY_POINT);
  });

  it('reports what it would remove without removing it', async () => {
    const report = await runClean('--keep', '1', '--tag', 'scheduled', '--dry-run');

    expect(report.wouldRemove).toEqual([OLDER_SCHEDULED]);
    expect(existsSync(join(backupsRoot, OLDER_SCHEDULED))).toBe(true);
    expect(existsSync(join(backupsRoot, MANUAL_RECOVERY_POINT))).toBe(true);
  });

  it('keeps every class when no tag is given — the unscoped clean is the dangerous one', async () => {
    // Pinned on purpose: a clean without a tag reaches every class, so the
    // tag is not decoration. If this ever changes, it has to change loudly.
    await runClean('--keep', '1');

    expect(existsSync(join(backupsRoot, OLDER_SCHEDULED))).toBe(false);
    expect(existsSync(join(backupsRoot, MANUAL_RECOVERY_POINT))).toBe(false);
  });
});
