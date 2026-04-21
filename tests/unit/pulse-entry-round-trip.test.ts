import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadPulseEntries,
  writePulseEvent,
} from '../../src/infra/runtime/heartbeat-watchdog.js';

let previousMemphisDir: string | undefined;
let scratch = '';

beforeEach(() => {
  previousMemphisDir = process.env.MEMPHIS_DATA_DIR;
  scratch = mkdtempSync(join(tmpdir(), 'memphis-pulse-roundtrip-'));
  process.env.MEMPHIS_DATA_DIR = scratch;
});

afterEach(() => {
  if (previousMemphisDir === undefined) {
    delete process.env.MEMPHIS_DATA_DIR;
  } else {
    process.env.MEMPHIS_DATA_DIR = previousMemphisDir;
  }
});

describe('PULSE.md detail round-trip', () => {
  it('preserves the detail field across write → load → rewrite', () => {
    writePulseEvent({
      timestamp: '2026-04-21T10:00:00.000Z',
      event: 'heartbeat',
      health: 'degraded',
      uptimeSeconds: 60,
      detail: 'warn:embed_bridge:bridge unavailable warn:memory:475/524 MB (91%)',
    });

    const loaded = loadPulseEntries();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].detail).toBe(
      'warn:embed_bridge:bridge unavailable warn:memory:475/524 MB (91%)',
    );
  });

  it('preserves cognitiveMode + activeSurfaces + detail together', () => {
    writePulseEvent({
      timestamp: '2026-04-21T10:05:00.000Z',
      event: 'heartbeat',
      health: 'degraded',
      uptimeSeconds: 300,
      cognitiveMode: 'A',
      activeSurfaces: ['telegram', 'tui'],
      detail: 'warn:memory:92%',
    });

    const [entry] = loadPulseEntries();
    expect(entry.cognitiveMode).toBe('A');
    expect(entry.activeSurfaces).toEqual(['telegram', 'tui']);
    expect(entry.detail).toBe('warn:memory:92%');
  });

  it('healthy heartbeats without detail stay undetailed after reload', () => {
    writePulseEvent({
      timestamp: '2026-04-21T10:10:00.000Z',
      event: 'heartbeat',
      health: 'healthy',
      uptimeSeconds: 120,
    });

    const [entry] = loadPulseEntries();
    expect(entry.detail).toBeUndefined();
    expect(entry.health).toBe('healthy');
  });

  it('preserves a detail string that legitimately contains "mode=…" and "surfaces=…"', () => {
    // Codex follow-up on #217: the parser previously ran
    // `/(?:^|\s)mode=(\S+)/` against the full tail, which would pull
    // the literal "mode=readonly" out of a detail like
    // "fail:chain_adapter:mode=readonly blocked" and misassign it to
    // cognitiveMode — and drop it from detail on rewrite. The
    // positional parser must leave these substrings inside detail
    // when they are not in the mode / surfaces prefix slot.
    writePulseEvent({
      timestamp: '2026-04-21T10:17:00.000Z',
      event: 'heartbeat',
      health: 'degraded',
      uptimeSeconds: 60,
      detail: 'fail:chain_adapter:mode=readonly surfaces=mcp blocked',
    });

    const [entry] = loadPulseEntries();
    expect(entry.cognitiveMode).toBeUndefined();
    expect(entry.activeSurfaces).toBeUndefined();
    expect(entry.detail).toBe('fail:chain_adapter:mode=readonly surfaces=mcp blocked');
  });

  it('still extracts mode / surfaces when they appear in the prefix slot even with a literal "mode=" in detail', () => {
    writePulseEvent({
      timestamp: '2026-04-21T10:18:00.000Z',
      event: 'heartbeat',
      health: 'degraded',
      uptimeSeconds: 60,
      cognitiveMode: 'B',
      activeSurfaces: ['tui'],
      detail: 'fail:vault:mode=locked requires pepper',
    });

    const [entry] = loadPulseEntries();
    expect(entry.cognitiveMode).toBe('B');
    expect(entry.activeSurfaces).toEqual(['tui']);
    expect(entry.detail).toBe('fail:vault:mode=locked requires pepper');
  });

  it('writes a second entry without losing detail from the first', () => {
    writePulseEvent({
      timestamp: '2026-04-21T10:15:00.000Z',
      event: 'heartbeat',
      health: 'degraded',
      uptimeSeconds: 60,
      detail: 'warn:memory:91%',
    });
    // Simulate the next heartbeat rewriting PULSE.md via loadPulseEntries
    // (which runs inside writePulseEvent). Before this fix, the first
    // entry's detail was dropped here.
    writePulseEvent({
      timestamp: '2026-04-21T10:16:00.000Z',
      event: 'heartbeat',
      health: 'healthy',
      uptimeSeconds: 120,
    });

    const entries = loadPulseEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].detail).toBe('warn:memory:91%');
    expect(entries[1].detail).toBeUndefined();
  });
});
