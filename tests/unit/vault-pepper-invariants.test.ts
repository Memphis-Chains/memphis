/**
 * Vault pepper single-artifact invariant — locks in the audit finding
 * from `docs/dev/vault-pepper-atomic-rotate-plan-2026-05-12.md`.
 *
 * The audit confirmed that pepper (MEMPHIS_VAULT_PEPPER) wraps exactly
 * ONE persistent artifact: `vault-state.json` (the file that holds the
 * encrypted master key). Vault entries themselves are encrypted under
 * the master key, not pepper, so pepper rotation only needs to re-wrap
 * the state file — no walker, no atomic-flip-across-many-files dance.
 *
 * If a future PR introduces a SECOND pepper-encrypted artifact — i.e.
 * adds another call site that uses pepper as direct AEAD key material —
 * this test fails and the contributor either:
 *
 *   1. Adds the new artifact to `rotateVaultStatePepper`'s walker
 *      (legitimate expansion — also update this invariant), OR
 *   2. Derives a sub-key from the master key instead of using pepper
 *      directly (preferred — keeps rotation surface single-artifact).
 *
 * Without this test, the next agent who reads
 * `feedback_pepper_desync_twice_same_day` could re-derive the
 * 12-16h "atomic re-encrypt every pepper-keyed artifact" plan based
 * on a stale problem statement and ship unnecessary crypto code.
 */
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');

/**
 * Grep for production call sites that use pepper as direct key material
 * for an AEAD encrypt/decrypt step. Excludes:
 *   - test files (`#[cfg(test)]`, `tests/`, `*.test.ts`, `.spec.ts`)
 *   - the legacy v1 compat path (deprecated, no production callers)
 *   - the rotation tooling itself (which by definition handles pepper)
 *
 * The audit baseline (2026-05-12): exactly one production-side
 * artifact path uses pepper as direct AEAD key — `deriveStateEncryptionKey`
 * in `src/infra/storage/rust-vault-adapter.ts`, which the Rust mirror
 * at `crates/memphis-operator/src/runtime.rs:decrypt_master_key_v2`
 * reads. Both encrypt the same `vault-state.json` artifact.
 */
describe('vault pepper single-artifact invariant', () => {
  it('only one production helper derives a key directly from pepper for AEAD use', () => {
    // Search both TS and Rust source trees for the patterns that
    // signal a pepper → encryption-key derivation. The grep is
    // intentionally narrow: we want the helper functions, not every
    // env read.
    const out = execSync(
      // eslint-disable-next-line no-restricted-syntax
      'grep -rnE ' +
        '"deriveStateEncryptionKey|decrypt_master_key_v2|encrypt_master_key_v2" ' +
        '--include="*.ts" --include="*.rs" ' +
        'src crates ' +
        '| grep -v "#\\[cfg(test)\\]" ' +
        '| grep -v "tests/" ' +
        '| grep -v "\\.test\\." ' +
        '| grep -v "\\.spec\\." ' +
        '|| true',
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    // Each match line is a separate call site. We expect the helpers
    // to exist (1 definition each) + a handful of internal callers
    // within the rotate / serialize / deserialize path. The exact
    // count is less important than the SET of files — we should see
    // ONLY rust-vault-adapter.ts (TS side) + memphis-operator/runtime.rs
    // (Rust side).
    const files = new Set(
      out
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => l.split(':')[0])
        .filter((f) => f && f.length > 0),
    );

    // Drop the test file itself from the result (this file mentions
    // the helper names in comments).
    files.delete('tests/unit/vault-pepper-invariants.test.ts');

    // Expected: exactly two files. Add to this allowlist ONLY when the
    // new file legitimately encrypts a NEW artifact under pepper AND
    // is wired into `rotateVaultStatePepper`'s walker.
    const allowlist = new Set([
      'src/infra/storage/rust-vault-adapter.ts',
      'crates/memphis-operator/src/runtime.rs',
    ]);

    for (const file of files) {
      expect(
        allowlist.has(file),
        `Unexpected production-side pepper-AEAD helper in ${file}. ` +
          `If this is intentional, add the new artifact to ` +
          `\`rotateVaultStatePepper\` AND extend the allowlist in ` +
          `tests/unit/vault-pepper-invariants.test.ts. ` +
          `Otherwise, derive a sub-key from the master key instead.`,
      ).toBe(true);
    }
  });

  it('rotation tooling targets exactly one artifact path', () => {
    // `rotateVaultStatePepper` should reference only `vault-state.json`.
    // Any reference to ANOTHER artifact name in the same function body
    // is a red flag.
    const rotateBody = execSync(
      // eslint-disable-next-line no-restricted-syntax
      'sed -n "/^export function rotateVaultStatePepper/,/^}/p" ' +
        'src/infra/storage/rust-vault-adapter.ts',
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    // Must reference vault-state.json.
    expect(rotateBody).toContain('vault-state.json');

    // Must NOT reference other artifact filenames (sanity — these are
    // the names we'd see if someone wired a second target without
    // touching this test).
    expect(rotateBody).not.toContain('tier3-sessions.json');
    expect(rotateBody).not.toContain('vault-entries.json');
    expect(rotateBody).not.toContain('provider-secrets.json');
  });
});
