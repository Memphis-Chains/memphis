/**
 * The client dashboard must never leak into the public repository, and
 * the publish path must be able to fail safely.
 *
 * Measured 2026-10-29: `client-status/` was created in the memphis-v5
 * docroot to hold the client's status page — a page carrying a third
 * party's name, their domain, their product list and their prices. The
 * pull in `sites/scripts/sites-sync.sh` copied production into the repo
 * master, and its exclude list did NOT mention `client-status/`. The
 * next `--pull` would have committed the client's business data to a
 * PUBLIC GitHub repository.
 *
 * That is the same class of leak the history scrub fixed on 2026-10-07,
 * and it was one missing `--exclude` away from happening again.
 *
 * The second contract is the publish itself: it must back up, it must
 * verify what the server actually serves, and it must restore the backup
 * when either the copy or the verification fails. A publish script that
 * can leave a half-written page on the server is worse than no script.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..');
const SYNC = join(REPO, 'sites', 'scripts', 'sites-sync.sh');
const PUBLISH = join(REPO, 'scripts', 'publish-client-dashboard.sh');
const ESTATE = join(REPO, 'sites', 'estate.json');

describe('client dashboard stays out of the public repo', () => {
  it('excludes client-status from the pull that copies production into the repo', () => {
    const source = readFileSync(SYNC, 'utf8');
    // The exclude has to be on the PULL, which is the copy that lands
    // in the repo master. A mention anywhere else does nothing.
    const pullSection = source.slice(source.indexOf('rsync_pull()'), source.indexOf('rsync_push'));
    expect(pullSection).toContain("--exclude 'client-status/'");
  });

  it('declares client-status server-owned in the estate', () => {
    const estate = JSON.parse(readFileSync(ESTATE, 'utf8')) as {
      serverOwnedNeverRsync: string[];
    };
    expect(estate.serverOwnedNeverRsync).toContain('memphis-v5/client-status');
  });

  it('keeps the client view out of the tracked repository', () => {
    // The generator must not carry the client's name either — the repo
    // is public. The name lives in a local config file instead.
    const generator = readFileSync(join(REPO, 'scripts', 'dashboard_report.py'), 'utf8');
    expect(generator).not.toContain('Szczepan');
    expect(generator).not.toContain('Dydych');
  });
});

describe('publish is safe', () => {
  it('backs up before it writes', () => {
    const source = readFileSync(PUBLISH, 'utf8');
    expect(source).toMatch(/\.bak/);
    // The backup must happen BEFORE the copy.
    const backupAt = source.indexOf('backing up remote copy');
    const publishAt = source.indexOf('publishing');
    expect(backupAt).toBeGreaterThan(-1);
    expect(publishAt).toBeGreaterThan(backupAt);
  });

  it('restores the backup on every failure path', () => {
    const source = readFileSync(PUBLISH, 'utf8');
    // Count the ACTUAL restore commands, not the log messages that
    // mention restoring. The first version of this test counted the
    // string "restoring backup", and the mutation that removed the
    // restore commands survived it — the log line was still there.
    const restores =
      source.match(/cp -a '\$REMOTE_BACKUP_DIR[^\n]*\$REMOTE_DIR\/\$REMOTE_FILE'/g) ?? [];
    // One per failure path: scp failure, stamp missing, wrong HTTP code.
    expect(restores.length).toBeGreaterThanOrEqual(3);

    // Each failure path must actually reach the restore, not just log.
    for (const marker of [
      'SCP FAILED',
      'VERIFY FAILED (stamp missing',
      'VERIFY FAILED (public path',
    ]) {
      const at = source.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      const after = source.slice(at, at + 600);
      expect(after).toMatch(/cp -a '\$REMOTE_BACKUP_DIR/);
    }
  });

  it('verifies the stamp the server actually serves', () => {
    const source = readFileSync(PUBLISH, 'utf8');
    expect(source).toContain('NEW_STAMP');
    expect(source).toMatch(/VERIFY FAILED/);
  });

  it('publishes nothing when the build fails', () => {
    const source = readFileSync(PUBLISH, 'utf8');
    expect(source).toContain('BUILD FAILED');
    expect(source).toMatch(/BUILD FAILED[\s\S]{0,400}exit 1/);
  });

  it('is syntactically valid bash', () => {
    expect(() => execFileSync('bash', ['-n', PUBLISH], { encoding: 'utf8' })).not.toThrow();
  });
});
