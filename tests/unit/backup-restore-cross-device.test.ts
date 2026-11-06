import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createBackup, restoreBackup } from '../../src/infra/cli/commands/backup.js';

// The test runner may put its checkout and tmpdir on one device. In the
// isolated cross-device drill the checkout is bind-mounted from disk and
// /tmp is tmpfs, just like the operator's affected host.
it.skipIf(statSync(process.cwd()).dev === statSync(tmpdir()).dev)(
  'refuses a cross-device restore before changing existing data or making pre-restore snapshots',
  async () => {
    const root = mkdtempSync(join(process.cwd(), '.restore-device-fixture-'));
    try {
      writeFileSync(join(root, 'archived.txt'), 'backup fixture');
      const backup = await createBackup({
        memphisRoot: root,
        backupRoot: join(root, 'backups'),
        showProgress: false,
      });
      writeFileSync(join(root, 'current.txt'), 'current user data');
      const backupsBefore = readdirSync(join(root, 'backups')).sort();
      await expect(
        restoreBackup({
          file: backup.backupPath,
          memphisRoot: root,
          backupRoot: join(root, 'backups'),
          confirm: true,
          showProgress: false,
        }),
      ).rejects.toThrow('Restore refused before changing data');
      expect(readFileSync(join(root, 'current.txt'), 'utf8')).toBe('current user data');
      expect(readdirSync(join(root, 'backups')).sort()).toEqual(backupsBefore);
      expect(existsSync(join(root, 'current.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
