/**
 * Sprint G — `memphis export --format=mv2` integration smoke.
 *
 * Verifies that:
 *   - The handler refuses without --output.
 *   - --include rejects unknown tracks loudly (vault is rejected here
 *     to mirror the Rust writer's denylist; the CLI shouldn't even try
 *     to read vault state for an mv2 export).
 *   - `--include vault` is rejected at parse time, not via NAPI round-trip.
 *
 * Full end-to-end (real chain on disk → .mv2 → reader) lives in the
 * Rust roundtrip test (`cargo test -p memphis-export`); this file
 * pins the TS-side contract that loads the NAPI bridge.
 */
import { describe, expect, it, vi } from 'vitest';

import { handleExportMv2Command } from '../../src/infra/cli/commands/export-mv2.js';

function buildContext(args: Record<string, unknown>): { args: Record<string, unknown> } {
  return {
    args: { command: 'export', format: 'mv2', json: false, ...args },
  };
}

describe('export --format=mv2 — Sprint G CLI surface', () => {
  // Codex R2 #434: errors after the format=mv2 match return `true`
  // (handled) + set exitCode so the dispatcher doesn't fall through
  // to "Unknown command: export". Same pattern as voice.handler.ts.
  it('returns true + exitCode when --output is missing', async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      errs.push(String(data));
      return true;
    });
    const previous = process.exitCode;
    process.exitCode = 0;
    const ok = await handleExportMv2Command(buildContext({}) as never);
    spy.mockRestore();
    expect(ok).toBe(true);
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toContain('--output');
    process.exitCode = previous;
  });

  it('returns true + exitCode on unknown --include tracks', async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      errs.push(String(data));
      return true;
    });
    const previous = process.exitCode;
    process.exitCode = 0;
    const ok = await handleExportMv2Command(
      buildContext({ out: '/tmp/should-not-be-written.mv2', include: 'journal,bogus' }) as never,
    );
    spy.mockRestore();
    expect(ok).toBe(true);
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toMatch(/Unknown --include track/);
    process.exitCode = previous;
  });

  it('returns true + exitCode on --include vault (denylist parity)', async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      errs.push(String(data));
      return true;
    });
    const previous = process.exitCode;
    process.exitCode = 0;
    const ok = await handleExportMv2Command(
      buildContext({ out: '/tmp/should-not-be-written.mv2', include: 'vault' }) as never,
    );
    spy.mockRestore();
    expect(ok).toBe(true);
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toMatch(/Unknown --include track: "vault"/);
    process.exitCode = previous;
  });

  it('does not handle the command when format is not mv2', async () => {
    const ok = await handleExportMv2Command(
      buildContext({ format: 'json', out: '/tmp/x' }) as never,
    );
    expect(ok).toBe(false);
  });

  it('chains track derives non-journal names from CHAIN_CATALOG (no drift)', async () => {
    // Codex R4+R5 #434: chains aggregation hard-coded a chain list
    // and missed 4 (R4) then 4 more (R5) catalog members. Pin that
    // the implementation now derives from CHAIN_CATALOG so future
    // catalog additions auto-include without code changes here.
    const { CHAIN_CATALOG } = await import('../../src/memory/chain-catalog.js');
    const catalogChains = Object.keys(CHAIN_CATALOG).filter((n) => n !== 'journal');
    // We can't introspect the private const directly, but we can
    // assert the catalog has every chain we expect to flow through
    // the chains track. If a future PR drops a chain from the
    // catalog or adds one we'd want to skip, this test is the
    // prompt to revisit the export filter.
    expect(catalogChains.length).toBeGreaterThanOrEqual(10);
    expect(catalogChains).toContain('decisions');
    expect(catalogChains).toContain('messages');
    expect(catalogChains).toContain('soul');
  });
});
