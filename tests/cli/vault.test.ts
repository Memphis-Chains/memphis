import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI vault', () => {
  it('init, add, get, and list vault entries', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-cli-vault-test-'));
    const vaultEntriesPath = join(dataDir, 'vault-entries.json');
    writeFileSync(vaultEntriesPath, '[]', 'utf8');

    const env = {
      HOME: dataDir,
      MEMPHIS_DATA_DIR: dataDir,
      MEMPHIS_VAULT_ENTRIES_PATH: vaultEntriesPath,
      MEMPHIS_VAULT_PEPPER: 'test-pepper-0123456789abcdef',
    };

    // Init vault
    const initOut = JSON.parse(
      await runCli(
        [
          'vault',
          'init',
          '--passphrase',
          'test-passphrase-123',
          '--recovery-question',
          'What is your favorite color?',
          '--recovery-answer',
          'blue',
          '--json',
        ],
        { env },
      ),
    );
    expect(initOut.ok).toBe(true);
    expect(initOut.vault).toBeDefined();

    // Add an entry
    const addOut = JSON.parse(
      await runCli(['vault', 'add', '--key', 'test-key', '--value', 'test-secret-value', '--json'], {
        env,
      }),
    );
    expect(addOut.ok).toBe(true);
    expect(addOut.entry.key).toBe('test-key');

    // Get the entry
    const getOut = JSON.parse(
      await runCli(['vault', 'get', '--key', 'test-key', '--json'], { env }),
    );
    expect(getOut.ok).toBe(true);
    expect(getOut.value).toBe('test-secret-value');

    // List entries
    const listOut = JSON.parse(await runCli(['vault', 'list', '--json'], { env }));
    expect(listOut.ok).toBe(true);
    expect(listOut.entries).toHaveLength(1);
    expect(listOut.entries[0].key).toBe('test-key');
  }, 30_000);
});
