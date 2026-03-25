import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../helpers/cli.js';

vi.mock('../../src/infra/auth/operator-gate.js', () => ({
  isOperatorConfigured: vi.fn(() => true),
  isSessionAuthorized: vi.fn(() => true),
  authorizeSession: vi.fn(),
  validateOperatorPassphrase: vi.fn(() => true),
  isGatedOperation: vi.fn(() => false),
  requireOperatorAuth: vi.fn(async () => true),
}));

describe('CLI vault flow', () => {
  it('supports init/add/get/list in JSON mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-vault-cli-'));
    const bridgePath = join(dir, 'mock-bridge.cjs');
    const entriesPath = join(dir, 'entries.json');

    writeFileSync(
      bridgePath,
      `module.exports = {
  vault_init_full: () => ({
    vault: { salt: Buffer.alloc(32, 1), masterKey: Buffer.alloc(32, 2) },
    did: 'did:memphis:cli',
    qa_question: 'pet?'
  }),
  vault_store: (_vault, key, plaintext) => ({
    id: 'entry-1',
    key,
    ciphertext: Buffer.from(plaintext),
    nonce: Buffer.alloc(12, 3),
    tag: Buffer.alloc(16, 4),
    created_at: new Date().toISOString()
  }),
  vault_retrieve: (_vault, entry) => Buffer.from(entry.ciphertext)
};`,
    );

    const env = {
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
      MEMPHIS_VAULT_PEPPER: 'very-secure-pepper',
      MEMPHIS_VAULT_ENTRIES_PATH: entriesPath,
      MEMPHIS_VAULT_STATE_PATH: join(dir, 'vault-state.json'),
      MEMPHIS_DATA_DIR: dir,
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
  }, 30_000);
});
