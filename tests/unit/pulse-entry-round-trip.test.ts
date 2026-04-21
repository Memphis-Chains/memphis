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
