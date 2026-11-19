import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isScannableChainDirectoryName } from '../../src/infra/storage/chain-adapter.js';

/**
 * The TypeScript arm of `memphis_chain_verify`, checked against the cases
 * where it and the native arm used to disagree.
 *
 * `tests/fixtures/chain-verify-contract.json` holds the cases; the native
 * runner is `crates/memphis-operator/tests/chain_verify_contract.rs`.
 *
 * Both arms read the SAME fixture: the disagreement was that the native
 * arm refused every archive directory (a dot is not in `[A-Za-z0-9_-]`),
 * so "verify all chains" aborted on the first archive and checked nothing,
 * while this arm skipped them and kept going.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(here, '..', 'fixtures', 'chain-verify-contract.json');

type ContractCase = {
  name: string;
  directory: string;
  scannable: boolean;
};

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { cases: ContractCase[] };

describe('memphis_chain_verify — the two arms agree', () => {
  it('holds at least one case', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it.each(fixture.cases)('$name', ({ directory, scannable }) => {
    expect(isScannableChainDirectoryName(directory)).toBe(scannable);
  });
});
