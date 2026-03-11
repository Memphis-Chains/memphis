import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI backup', () => {
  it('creates, lists, restores and cleans backups', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'memphis-cli-backup-test-'));
    const memphisDir = join(homeDir, '.memphis');
    const chainsDir = join(memphisDir, 'chains');
    const embeddingsDir = join(memphisDir, 'embeddings');
    const vaultDir = join(memphisDir, 'vault');
    const configDir = join(memphisDir, 'config');

    mkdirSync(chainsDir, { recursive: true });
    mkdirSync(embeddingsDir, { recursive: true });
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    writeFileSync(join(chainsDir, 'chain.txt'), 'v1', 'utf8');
    writeFileSync(join(embeddingsDir, 'index.json'), '{"ok":true}', 'utf8');
    writeFileSync(join(vaultDir, 'vault.json'), '{"secret":"x"}', 'utf8');
    writeFileSync(join(configDir, 'app.json'), '{"env":"test"}', 'utf8');

    const env = { HOME: homeDir };

    const createOut = JSON.parse(await runCli(['backup', '--json'], { env }));
    expect(createOut.ok).toBe(true);
    expect(createOut.mode).toBe('create');
    expect(createOut.id).toContain('backup-');

    const listOut = JSON.parse(await runCli(['backup', '--list', '--json'], { env }));
    expect(listOut.backups.length).toBeGreaterThanOrEqual(1);

    writeFileSync(join(chainsDir, 'chain.txt'), 'modified', 'utf8');

    await runCli(['backup', '--restore', createOut.id, '--yes', '--json'], { env });
    const restored = readFileSync(join(chainsDir, 'chain.txt'), 'utf8');
    expect(restored).toBe('v1');

    for (let index = 0; index < 3; index += 1) {
      await runCli(['backup', '--json'], { env });
    }

    const cleanOut = JSON.parse(
      await runCli(['backup', '--clean', '--keep', '2', '--json'], { env }),
    );
    expect(cleanOut.ok).toBe(true);

    const listedAfterClean = JSON.parse(await runCli(['backup', '--list', '--json'], { env }));
    expect(listedAfterClean.backups.length).toBeLessThanOrEqual(2);
  }, 30000);
});
