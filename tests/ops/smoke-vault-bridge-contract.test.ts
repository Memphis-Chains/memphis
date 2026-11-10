import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { hasRequiredBridgeExports } from '../../src/infra/storage/napi-contract.js';
import {
  LEGACY_VAULT_BRIDGE_ALIASES,
  NEW_VAULT_BRIDGE_ALIASES,
} from '../../src/infra/storage/rust-vault-adapter.js';

// The smoke test's bridge mock must satisfy the vault gate the adapter
// actually applies.
//
// Measured 2026-11-10: nightly crystal had been red for four days. The
// cause was `scripts/smoke-test.sh`, whose mock was last touched in
// June 2026. In October (10fac3d819) the TypeScript side stopped parsing
// persisted vault entries itself and began asking the bridge for them,
// so the mock needed three more exports than it had. Nothing failed
// loudly at the time: the smoke simply started failing, and the nightly
// report only said "Test exit=4" without naming the cause.
//
// This test reads the required export names from the adapter — the
// single source of truth — and applies the adapter's own gate
// (`hasRequiredBridgeExports`) to the mock. A mock that drifts from the
// contract now fails a test that says so, instead of a nightly run four
// days later that says "exit=4".

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const smokeScript = path.join(repoRoot, 'scripts', 'smoke-test.sh');

/** The mock module body, as written into the temp bridge file. */
function readMockBody(): string {
  const script = readFileSync(smokeScript, 'utf8');
  const start = script.indexOf('cat >"$BRIDGE_PATH" <<\'EOF\'');
  expect(start, 'smoke-test.sh must write a bridge mock').toBeGreaterThan(-1);
  const bodyStart = script.indexOf('\n', start) + 1;
  const end = script.indexOf('\nEOF\n', bodyStart);
  expect(end, 'smoke-test.sh must close the bridge mock heredoc').toBeGreaterThan(-1);
  return script.slice(bodyStart, end);
}

/** Export names the mock defines, the way the bridge sees them. */
function mockExportNames(): Set<string> {
  const body = readMockBody();
  const names = new Set<string>();
  for (const match of body.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):/gm)) {
    names.add(match[1]);
  }
  return names;
}

/** The adapter's gate, applied to a set of export names. */
function gateSatisfied(names: Set<string>, aliases: Record<string, readonly string[]>): boolean {
  const resolved: Record<string, (...args: unknown[]) => unknown> = {};
  for (const [key, candidates] of Object.entries(aliases)) {
    const found = candidates.find((candidate) => names.has(candidate));
    if (found) resolved[key] = () => undefined;
  }
  return hasRequiredBridgeExports(
    { bridgeLoaded: true, missing: [], legacyAliasesUsed: {}, resolved },
    Object.keys(aliases),
  );
}

describe('smoke bridge mock · vault contract', () => {
  it('satisfies the vault gate the adapter applies to a loaded bridge', () => {
    const names = mockExportNames();

    // The adapter accepts EITHER arm: the current contract, or the
    // legacy one. Measured on the real bridge: the native module exports
    // the current arm and the legacy arm too, so a mock of either shape
    // passes. What must not happen is a mock that satisfies neither.
    const newArm = gateSatisfied(names, NEW_VAULT_BRIDGE_ALIASES);
    const legacyArm = gateSatisfied(names, LEGACY_VAULT_BRIDGE_ALIASES);

    expect(
      newArm || legacyArm,
      'smoke bridge mock satisfies neither the current nor the legacy vault contract',
    ).toBe(true);
  });

  it('implements the current vault contract, which is what the reader path needs', () => {
    // The legacy arm alone would not be enough: the TypeScript reader
    // (vault_parse_entries / vault_decode_entry / vault_load_state) has
    // no legacy fallback, and the smoke exercises it.
    const names = mockExportNames();
    const missing = Object.entries(NEW_VAULT_BRIDGE_ALIASES)
      .filter(([, aliases]) => !aliases.some((alias) => names.has(alias)))
      .map(([key]) => key);

    expect(missing, 'smoke bridge mock is missing vault exports').toEqual([]);
  });

  it('keeps the vault entries path inside the test sandbox', () => {
    // Without this the entries path falls back to the inherited
    // environment, which on an operator machine is the PRODUCTION vault
    // (~/.memphis/vault-entries.json). Measured 2026-11-10: the smoke
    // test read the operator's real vault instead of its own.
    const script = readFileSync(smokeScript, 'utf8');
    expect(script).toContain('export MEMPHIS_VAULT_ENTRIES_PATH="$TMP_WORK/');
    expect(script).toContain('export MEMPHIS_VAULT_STATE_PATH="$TMP_WORK/');
  });
});
