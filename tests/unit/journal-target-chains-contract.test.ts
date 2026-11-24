import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { JOURNAL_TARGET_CHAINS, isJournalTargetChain } from '../../src/memory/chain-catalog.js';

/**
 * The TypeScript arm of the journal-target allowlist, checked against
 * the fixture the native arm also reads.
 *
 * `tests/fixtures/journal-target-chains-contract.json` holds the list; the
 * native runner is
 * `crates/memphis-operator/tests/journal_target_chains_contract.rs`.
 *
 * ## Why this test exists
 *
 * Both arms carried a copy of the list, and both files claimed to be
 * "checked against `tests/fixtures/journal-target-chains-contract.json`,
 * so the two arms cannot drift apart silently".
 *
 * The fixture did not exist. The claim was a comment, not a gate — and
 * the Rust copy of the list was not used by anything at all, which the
 * compiler reported as dead code.
 *
 * A duplicated list with no gate is a list that WILL drift: it is two
 * hand-maintained copies of the same rule, and nothing compares them.
 * This test makes the claim true.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(here, '..', 'fixtures', 'journal-target-chains-contract.json');

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { chains: string[] };

describe('the journal-target allowlist — the two arms agree', () => {
  it('holds at least one chain', () => {
    expect(fixture.chains.length).toBeGreaterThan(0);
  });

  it('matches the contract exactly', () => {
    expect([...JOURNAL_TARGET_CHAINS]).toEqual(fixture.chains);
  });

  it('keeps the audit-guarded chains out of the operator-facing list', () => {
    // `system` and `security` are written by the runtime's own audit
    // path, which refuses writes from processes that have not opted in.
    expect(JOURNAL_TARGET_CHAINS).not.toContain('system');
    expect(JOURNAL_TARGET_CHAINS).not.toContain('security');
  });

  it('answers the membership question from the same list', () => {
    for (const chain of fixture.chains) {
      expect(isJournalTargetChain(chain)).toBe(true);
    }
    expect(isJournalTargetChain('system')).toBe(false);
    expect(isJournalTargetChain('not-a-chain')).toBe(false);
  });
});
