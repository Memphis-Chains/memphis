import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function runCli(command: string, homeDir: string): string {
  return execSync(`MEMPHIS_SKIP_FIRST_RUN_CHECKS=1 HOME=${homeDir} npx tsx src/infra/cli/index.ts ${command}`, {
    encoding: 'utf8',
  });
}

describe('CLI backup', () => {
  it('creates, lists, restores and cleans backups', () => {
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

    const createOut = JSON.parse(runCli('backup --json', homeDir));
    expect(createOut.ok).toBe(true);
    expect(createOut.mode).toBe('create');
    expect(createOut.id).toContain('backup-');

    const listOut = JSON.parse(runCli('backup --list --json', homeDir));
    expect(listOut.backups.length).toBeGreaterThanOrEqual(1);

    writeFileSync(join(chainsDir, 'chain.txt'), 'modified', 'utf8');

    runCli(`backup --restore ${createOut.id} --yes --json`, homeDir);
    const restored = readFileSync(join(chainsDir, 'chain.txt'), 'utf8');
    expect(restored).toBe('v1');

    for (let i = 0; i < 3; i += 1) {
      runCli('backup --json', homeDir);
    }

    const cleanOut = JSON.parse(runCli('backup --clean --keep 2 --json', homeDir));
    expect(cleanOut.ok).toBe(true);

    const listedAfterClean = JSON.parse(runCli('backup --list --json', homeDir));
    expect(listedAfterClean.backups.length).toBeLessThanOrEqual(2);
  }, 30000);
});
