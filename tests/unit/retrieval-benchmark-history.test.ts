import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendHistory,
  evaluateTrendGate,
  latestComparable,
  loadHistory,
  saveHistory,
  type BenchmarkHistory,
} from '../../scripts/retrieval-benchmark-history.ts';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('retrieval benchmark history', () => {
  it('persists and reloads benchmark history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-bench-history-'));
    tempDirs.push(dir);
    const path = join(dir, 'history.json');

    const base: BenchmarkHistory = { version: 1, entries: [] };
    const updated = appendHistory(base, {
      k: 3,
      datasetPath: 'data/retrieval-benchmark-corpus-v2.json',
      cases: 20,
      baseline: { precisionAtK: 0.05, recallAtK: 0.15, mrr: 0.1167 },
      tuned: { precisionAtK: 0.3, recallAtK: 0.85, mrr: 0.575 },
      delta: { precisionAtK: 0.25, recallAtK: 0.7, mrr: 0.4583 },
    });

    saveHistory(path, updated);
    const loaded = loadHistory(path);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]?.datasetPath).toBe('data/retrieval-benchmark-corpus-v2.json');
  });

  it('fails trend gate on large regressions', () => {
    const previous = {
      ts: new Date().toISOString(),
      datasetPath: 'data/retrieval-benchmark-corpus-v2.json',
      k: 3,
      baseline: { precisionAtK: 0.05, recallAtK: 0.15, mrr: 0.1167 },
      tuned: { precisionAtK: 0.3, recallAtK: 0.85, mrr: 0.575 },
      delta: { precisionAtK: 0.25, recallAtK: 0.7, mrr: 0.4583 },
    };

    const current = {
      k: 3,
      datasetPath: 'data/retrieval-benchmark-corpus-v2.json',
      cases: 20,
      baseline: { precisionAtK: 0.05, recallAtK: 0.15, mrr: 0.1167 },
      tuned: { precisionAtK: 0.3, recallAtK: 0.8, mrr: 0.53 },
      delta: { precisionAtK: 0.25, recallAtK: 0.65, mrr: 0.4133 },
    };

    const failures = evaluateTrendGate(previous, current, {
      maxRecallDropFromPrevious: 0.02,
      maxMrrDropFromPrevious: 0.03,
    });

    expect(failures.length).toBeGreaterThan(0);
  });

  it('finds latest comparable baseline', () => {
    const history: BenchmarkHistory = {
      version: 1,
      entries: [
        {
          ts: '2026-03-01T00:00:00.000Z',
          datasetPath: 'data/retrieval-benchmark-baseline.json',
          k: 3,
          baseline: { precisionAtK: 0, recallAtK: 0, mrr: 0 },
          tuned: { precisionAtK: 0, recallAtK: 0, mrr: 0 },
          delta: { precisionAtK: 0, recallAtK: 0, mrr: 0 },
        },
        {
          ts: '2026-03-02T00:00:00.000Z',
          datasetPath: 'data/retrieval-benchmark-corpus-v2.json',
          k: 3,
          baseline: { precisionAtK: 0.05, recallAtK: 0.15, mrr: 0.1167 },
          tuned: { precisionAtK: 0.3, recallAtK: 0.85, mrr: 0.575 },
          delta: { precisionAtK: 0.25, recallAtK: 0.7, mrr: 0.4583 },
        },
      ],
    };

    const hit = latestComparable(history, {
      k: 3,
      datasetPath: 'data/retrieval-benchmark-corpus-v2.json',
      cases: 20,
      baseline: { precisionAtK: 0, recallAtK: 0, mrr: 0 },
      tuned: { precisionAtK: 0, recallAtK: 0, mrr: 0 },
      delta: { precisionAtK: 0, recallAtK: 0, mrr: 0 },
    });

    expect(hit?.ts).toBe('2026-03-02T00:00:00.000Z');
  });
});
