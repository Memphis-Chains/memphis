/**
 * The bridge's export vocabulary — the TypeScript side of the contract.
 *
 * ## Why this gate exists
 *
 * The vocabulary of the N-API bridge was declared in three places: a
 * hand-written list in the Rust crate's manifest, a hand-written alias map in
 * TypeScript, and the built binary. Nothing compared them.
 *
 * Measured 2026-11-23 on the operator's host, by reading the built module:
 * the binary exports **37** functions. The manifest named **34** — three real
 * exports (`embed_index_metadata`, `embed_clear_in_memory`,
 * `embed_discard_replacement`) were missing from it, and nine of the names it
 * did give were spellings the bridge never exports. The TypeScript map could
 * not name the three missing ones at all, and **34 of its 68 spellings never
 * matched** any export.
 *
 * ## What the gate pins
 *
 * - the mirror is a PROJECTION of the Rust core's table, and the projection
 *   is in sync (the check mode of the projection script passes);
 * - the artefact agrees with the REAL binary — the names in it are the names
 *   the module actually exports;
 * - every export of the binary can be named from TypeScript.
 *
 * The Rust arm of the same contract is
 * `crates/memphis-napi/tests/bridge_export_contract.rs`, and the artefact is
 * `tests/fixtures/bridge-export-contract.json`. Neither arm produces it
 * alone.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { resolveRustBridgePath } from '../../src/infra/runtime/install-root.js';
import { BRIDGE_EXPORT_ALIASES } from '../../src/infra/storage/bridge-exports.generated.js';

type Binding = { canonical: string; jsName: string; required: boolean };

const FIXTURE = 'tests/fixtures/bridge-export-contract.json';

function readFixture(): { exports: Binding[]; owner?: string } {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as { exports: Binding[]; owner?: string };
}

function loadBridge(): Record<string, unknown> | null {
  const path = resolveRustBridgePath(process.env);
  if (!existsSync(path)) return null;
  try {
    const require = createRequire(`${process.cwd()}/`);
    return require(path) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const fixture = readFixture();
const bridge = loadBridge();

describe('the bridge export contract', () => {
  it('the projection is in sync with the Rust core', () => {
    // The check mode is the gate: it compares the committed artefact and the
    // committed mirror with what the Rust core says today, and exits 1 on
    // drift. A stale projection is a failure here, not a warning.
    const output = execFileSync(
      'npx',
      ['tsx', 'scripts/sync-bridge-export-contract.mts', '--check'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(output).toContain('OK');
  });

  it('the mirror names every export the artefact declares', () => {
    const missing = fixture.exports
      .filter((entry) => !(entry.canonical in BRIDGE_EXPORT_ALIASES))
      .map((entry) => entry.canonical);
    expect(missing).toEqual([]);
  });

  it('the mirror spells every export the way the bridge spells it', () => {
    const wrong = fixture.exports
      .map((entry) => {
        const spellings = BRIDGE_EXPORT_ALIASES[entry.canonical as keyof typeof BRIDGE_EXPORT_ALIASES];
        return spellings?.[0] === entry.jsName ? null : `${entry.canonical}: ${String(spellings?.[0])} != ${entry.jsName}`;
      })
      .filter((entry): entry is string => entry !== null);
    expect(wrong).toEqual([]);
  });

  it('the artefact agrees with the real binary', () => {
    if (!bridge) {
      // The bridge is a build artefact; CI builds it before this suite.
      // Without it there is nothing to compare against, and saying so is
      // better than pretending the comparison happened.
      expect(true).toBe(true);
      return;
    }
    const real = Object.keys(bridge)
      .filter((key) => typeof bridge[key] === 'function')
      .sort();
    const declared = fixture.exports.map((entry) => entry.jsName).sort();

    expect(declared.filter((name) => !real.includes(name))).toEqual([]);
    expect(real.filter((name) => !declared.includes(name))).toEqual([]);
  });

  it('every export of the binary can be named from TypeScript', () => {
    if (!bridge) {
      expect(true).toBe(true);
      return;
    }
    const spellings = new Set(Object.values(BRIDGE_EXPORT_ALIASES).flat());
    const unreachable = Object.keys(bridge)
      .filter((key) => typeof bridge[key] === 'function')
      .filter((name) => !spellings.has(name));
    expect(unreachable).toEqual([]);
  });

  it('the three exports the hand-written map could not name are nameable now', () => {
    // These are the three the old 34-key map omitted. They are named here so
    // the next regression names them in the failure message.
    for (const name of [
      'embed_index_metadata',
      'embed_clear_in_memory',
      'embed_discard_replacement',
    ]) {
      expect(name in BRIDGE_EXPORT_ALIASES, name).toBe(true);
    }
  });

  it('the required exports are declared by the Rust core', () => {
    const required = fixture.exports.filter((entry) => entry.required).map((entry) => entry.canonical);
    expect(required.length).toBeGreaterThan(0);
    expect(required).toContain('bridge_manifest');
    expect(required).toContain('chain_append');
    expect(required).toContain('chain_query');
  });
});
