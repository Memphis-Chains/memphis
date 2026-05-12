/**
 * Refuse-on-nonempty guard for `memphis vault init`.
 *
 * Root-cause fix for the pepper desync that bit on 2026-05-11
 * 15:57 → 16:07 and forced operator's full vault reset on
 * 2026-05-13. The boundary (`src/security/vault-boundary.ts`) had
 * the invariant via `MEMPHIS_VAULT_FORCE_REINIT`, but only refused
 * AFTER interactive prompts had collected operator input. The CLI
 * guard short-circuits before any prompt fires so a stray
 * `vault init` on a populated vault can't silently regenerate the
 * master-key envelope while the existing entries stay on disk.
 *
 * Four branches verified here:
 *   1. greenfield (no entries file at all)            → init succeeds
 *   2. empty entries file `[]`                         → init succeeds
 *   3. non-empty, no override                          → init refuses
 *   4. non-empty + `--force-reinit`                    → init succeeds
 *
 * The boundary's env-var path (`MEMPHIS_VAULT_FORCE_REINIT=1`) is the
 * legacy / scriptable alias and is verified separately by
 * `tests/unit/vault-boundary.test.ts`. We test the flag path here
 * because it is the CLI-discoverable shape operators reach for.
 */
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli, runCliResult } from '../helpers/cli.js';

const PASSPHRASE = 'test-passphrase-123';
const RECOVERY_Q = 'Color of the test fixture?';
const RECOVERY_A = 'magenta';

function envFor(dataDir: string): NodeJS.ProcessEnv {
  return {
    HOME: dataDir,
    MEMPHIS_DATA_DIR: dataDir,
    MEMPHIS_VAULT_ENTRIES_PATH: join(dataDir, 'vault-entries.json'),
    MEMPHIS_VAULT_PEPPER: 'test-pepper-0123456789abcdef',
  };
}

function initArgs(extra: string[] = []): string[] {
  return [
    'vault',
    'init',
    '--passphrase',
    PASSPHRASE,
    '--recovery-question',
    RECOVERY_Q,
    '--recovery-answer',
    RECOVERY_A,
    '--json',
    ...extra,
  ];
}

describe('CLI vault init refuse-on-nonempty', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memphis-vault-init-guard-'));
  });

  afterEach(() => {
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('succeeds on a greenfield install (no entries file present)', async () => {
    // No vault-entries.json at all. Should be allowed.
    const out = JSON.parse(await runCli(initArgs(), { env: envFor(dataDir) }));
    expect(out.ok).toBe(true);
    expect(out.vault).toBeDefined();
  }, 30_000);

  it('succeeds when entries file exists but is the empty array `[]`', async () => {
    // Matches the existing `tests/cli/vault.test.ts` setup: empty `[]` is
    // the "no entries yet" sentinel after a `vault reset` or a fresh
    // touch — must remain allowed.
    writeFileSync(join(dataDir, 'vault-entries.json'), '[]', 'utf8');
    const out = JSON.parse(await runCli(initArgs(), { env: envFor(dataDir) }));
    expect(out.ok).toBe(true);
  }, 30_000);

  it('refuses when entries file has secrets and no override is passed', async () => {
    // Simulate the bug shape: vault-entries.json already populated by a
    // prior `vault add` (or restored from backup). A stray `vault init`
    // here is the exact event that produced 2026-05-11's pepper desync.
    const fakeEntries = [
      {
        key: 'minimax_api_key',
        encrypted: 'base64-ciphertext',
        iv: 'base64-iv',
        createdAt: new Date().toISOString(),
        fingerprint: 'fp-1',
      },
    ];
    writeFileSync(
      join(dataDir, 'vault-entries.json'),
      JSON.stringify(fakeEntries),
      'utf8',
    );

    const result = await runCliResult(initArgs(), { env: envFor(dataDir) });
    expect(result.status).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toMatch(/refusing to re-initialize/i);
    expect(combined).toMatch(/--force-reinit/);
    expect(combined).toMatch(/1 encrypted entries/);

    // The pre-existing entries file must NOT have been mutated — the
    // refusal must short-circuit BEFORE any vault write happens.
    const onDisk = readFileSync(join(dataDir, 'vault-entries.json'), 'utf8');
    expect(JSON.parse(onDisk)).toEqual(fakeEntries);
    expect(existsSync(join(dataDir, 'vault-state.json'))).toBe(false);
  }, 30_000);

  it('proceeds when --force-reinit is passed explicitly', async () => {
    // Operator opted in. The flag is the discoverable shape; the
    // env-var bypass (MEMPHIS_VAULT_FORCE_REINIT=1) is tested at the
    // boundary layer. Either is sufficient.
    const fakeEntries = [
      {
        key: 'minimax_api_key',
        encrypted: 'base64-ciphertext',
        iv: 'base64-iv',
        createdAt: new Date().toISOString(),
        fingerprint: 'fp-1',
      },
    ];
    writeFileSync(
      join(dataDir, 'vault-entries.json'),
      JSON.stringify(fakeEntries),
      'utf8',
    );

    const out = JSON.parse(
      await runCli(initArgs(['--force-reinit']), { env: envFor(dataDir) }),
    );
    expect(out.ok).toBe(true);
    expect(out.vault).toBeDefined();
  }, 30_000);
});
