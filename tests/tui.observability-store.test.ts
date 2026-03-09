import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { appendSnapshot, loadLatestSnapshot } from '../src/tui/observability-store.js';

describe('tui observability store', () => {
  it('appends and loads latest snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-obs-'));
    try {
      const path = join(dir, 'obs.json');
      appendSnapshot(path, {
        ts: '2026-01-01T00:00:00.000Z',
        requests: 1,
        fallbackAttempts: 0,
        totalAttempts: 1,
        avgTimingMs: 120,
        recentTimingsMs: [120],
        lastProvider: 'shared-llm',
      });
      appendSnapshot(path, {
        ts: '2026-01-01T00:00:05.000Z',
        requests: 2,
        fallbackAttempts: 1,
        totalAttempts: 3,
        avgTimingMs: 100,
        recentTimingsMs: [120, 80],
        lastProvider: 'local-fallback',
      });

      const latest = loadLatestSnapshot(path);
      expect(latest?.requests).toBe(2);
      expect(latest?.lastProvider).toBe('local-fallback');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
