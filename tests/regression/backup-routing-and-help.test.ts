import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCliResult } from '../helpers/cli.js';

describe('CLI backup routing + --help safety regression', () => {
  it('does not create a backup for subcommands and short-circuits on --help', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'memphis-backup-routing-'));
    const dataDir = join(homeDir, 'memphis-data');
    const env = { MEMPHIS_DATA_DIR: dataDir };
    const backupsDir = join(dataDir, 'backups');

    const helpResult = await runCliResult(['backup', '--help', '--json'], { env });
    expect(helpResult.status).toBe(0);

    const before = existsSync(backupsDir)
      ? readdirSync(backupsDir, { withFileTypes: true }).filter((d) => d.name.endsWith('.tar.gz'))
          .length
      : 0;

    const listResult = await runCliResult(['backup', 'list', '--json'], { env });
    expect(listResult.status).toBe(0);

    const after = readdirSync(backupsDir, { withFileTypes: true }).filter((d) =>
      d.name.endsWith('.tar.gz'),
    ).length;
    expect(after).toBe(before);
  });
});
