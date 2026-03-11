import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI vault flow', () => {
  it('supports init/add/get/list in JSON mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-vault-cli-'));
    const bridgePath = join(dir, 'mock-bridge.cjs');
    const entriesPath = join(dir, 'entries.json');

    writeFileSync(
      bridgePath,
      `module.exports = {
  vault_init: () => JSON.stringify({ ok: true, data: { version: 1, did: 'did:memphis:cli' } }),
  vault_encrypt: (key, plaintext) => JSON.stringify({ ok: true, data: { key, encrypted: 'enc:' + plaintext, iv: 'iv' } }),
  vault_decrypt: (entryJson) => {
    const e = JSON.parse(entryJson);
    return JSON.stringify({ ok: true, data: { plaintext: String(e.encrypted).replace('enc:', '') } });
  }
};`,
    );

    const env = {
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
      MEMPHIS_VAULT_PEPPER: 'very-secure-pepper',
      MEMPHIS_VAULT_ENTRIES_PATH: entriesPath,
    };

    const init = await runCli(
      [
        'vault',
        'init',
        '--passphrase',
        'pass123456789',
        '--recovery-question',
        'pet',
        '--recovery-answer',
        'nori',
        '--json',
      ],
      { env },
    );
    expect(JSON.parse(init).ok).toBe(true);

    const add = await runCli(
      ['vault', 'add', '--key', 'SHARED_LLM_API_KEY', '--value', 'sk-test', '--json'],
      { env },
    );
    expect(JSON.parse(add).ok).toBe(true);

    const got = await runCli(['vault', 'get', '--key', 'SHARED_LLM_API_KEY', '--json'], {
      env,
    });
    expect(JSON.parse(got).value).toBe('sk-test');

    const list = await runCli(['vault', 'list', '--key', 'SHARED_LLM_API_KEY', '--json'], {
      env,
    });
    expect(JSON.parse(list).entries.length).toBe(1);
  }, 15000);
});
