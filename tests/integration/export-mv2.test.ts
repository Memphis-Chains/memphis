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
  it('returns false (with stderr) when --output is missing', async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      errs.push(String(data));
      return true;
    });
    const ok = await handleExportMv2Command(buildContext({}) as never);
    spy.mockRestore();
    expect(ok).toBe(false);
    expect(errs.join('\n')).toContain('--output');
  });

  it('rejects unknown --include tracks before touching the bridge', async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      errs.push(String(data));
      return true;
    });
    const ok = await handleExportMv2Command(
      buildContext({ out: '/tmp/should-not-be-written.mv2', include: 'journal,bogus' }) as never,
    );
    spy.mockRestore();
    expect(ok).toBe(false);
    expect(errs.join('\n')).toMatch(/Unknown --include track/);
  });

  it('rejects --include vault at parse time (denylist parity)', async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      errs.push(String(data));
      return true;
    });
    const ok = await handleExportMv2Command(
      buildContext({ out: '/tmp/should-not-be-written.mv2', include: 'vault' }) as never,
    );
    spy.mockRestore();
    expect(ok).toBe(false);
    expect(errs.join('\n')).toMatch(/Unknown --include track: "vault"/);
  });

  it('does not handle the command when format is not mv2', async () => {
    const ok = await handleExportMv2Command(
      buildContext({ format: 'json', out: '/tmp/x' }) as never,
    );
    expect(ok).toBe(false);
  });
});
