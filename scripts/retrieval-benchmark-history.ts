import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BenchmarkOutput, Metrics } from './retrieval-benchmark.ts';

export type BenchmarkHistoryEntry = {
  ts: string;
  gitRef?: string;
  datasetPath: string;
  k: number;
  baseline: Metrics;
  tuned: Metrics;
  delta: Metrics;
};

export type BenchmarkHistory = {
  version: 1;
  entries: BenchmarkHistoryEntry[];
};

export type TrendThresholds = {
  maxRecallDropFromPrevious: number;
  maxMrrDropFromPrevious: number;
  maxRecallDropFromRollingMean?: number;
  maxMrrDropFromRollingMean?: number;
  rollingWindow?: number;
};

export function historyPathFromEnv(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return resolve(rawEnv.RETRIEVAL_BENCH_HISTORY_PATH ?? 'data/retrieval-benchmark-history.json');
}

export function loadHistory(path: string): BenchmarkHistory {
  if (!existsSync(path)) return { version: 1, entries: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BenchmarkHistory>;
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    return { version: 1, entries: [] };
  }
  return {
    version: 1,
    entries: parsed.entries
      .filter((e): e is BenchmarkHistoryEntry => Boolean(e && typeof e.datasetPath === 'string' && typeof e.k === 'number'))
      .slice(-300),
  };
}

export function appendHistory(history: BenchmarkHistory, run: BenchmarkOutput, rawEnv: NodeJS.ProcessEnv = process.env): BenchmarkHistory {
  const entry: BenchmarkHistoryEntry = {
    ts: new Date().toISOString(),
    gitRef: rawEnv.GITHUB_SHA ?? rawEnv.GIT_COMMIT,
    datasetPath: run.datasetPath,
    k: run.k,
    baseline: run.baseline,
    tuned: run.tuned,
    delta: run.delta,
  };
  const next = [...history.entries, entry].slice(-300);
  return { version: 1, entries: next };
}

export function saveHistory(path: string, history: BenchmarkHistory): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(history, null, 2));
}

export function latestComparable(history: BenchmarkHistory, run: BenchmarkOutput): BenchmarkHistoryEntry | null {
  for (let i = history.entries.length - 1; i >= 0; i -= 1) {
    const entry = history.entries[i];
    if (entry?.datasetPath === run.datasetPath && entry.k === run.k) return entry;
  }
  return null;
}

export function evaluateTrendGate(
  previous: BenchmarkHistoryEntry | null,
  run: BenchmarkOutput,
  thresholds: TrendThresholds,
  history?: BenchmarkHistory,
): string[] {
  const failures: string[] = [];

  if (previous) {
    const recallDrop = Number((previous.tuned.recallAtK - run.tuned.recallAtK).toFixed(4));
    const mrrDrop = Number((previous.tuned.mrr - run.tuned.mrr).toFixed(4));

    if (recallDrop > thresholds.maxRecallDropFromPrevious) {
      failures.push(
        `trend recall drop too high: ${run.tuned.recallAtK} vs prev ${previous.tuned.recallAtK} (drop ${recallDrop} > ${thresholds.maxRecallDropFromPrevious})`,
      );
    }

    if (mrrDrop > thresholds.maxMrrDropFromPrevious) {
      failures.push(
        `trend mrr drop too high: ${run.tuned.mrr} vs prev ${previous.tuned.mrr} (drop ${mrrDrop} > ${thresholds.maxMrrDropFromPrevious})`,
      );
    }
  }

  if (history && history.entries.length > 0) {
    const windowSize = Math.max(2, thresholds.rollingWindow ?? 5);
    const comparable = history.entries
      .filter((entry) => entry.datasetPath === run.datasetPath && entry.k === run.k)
      .slice(-windowSize);

    if (comparable.length >= 2) {
      const meanRecall = comparable.reduce((acc, e) => acc + e.tuned.recallAtK, 0) / comparable.length;
      const meanMrr = comparable.reduce((acc, e) => acc + e.tuned.mrr, 0) / comparable.length;

      const recallDropFromMean = Number((meanRecall - run.tuned.recallAtK).toFixed(4));
      const mrrDropFromMean = Number((meanMrr - run.tuned.mrr).toFixed(4));

      const recallThreshold = thresholds.maxRecallDropFromRollingMean ?? thresholds.maxRecallDropFromPrevious;
      const mrrThreshold = thresholds.maxMrrDropFromRollingMean ?? thresholds.maxMrrDropFromPrevious;

      if (recallDropFromMean > recallThreshold) {
        failures.push(
          `trend recall drop vs rolling-${comparable.length} mean too high: ${run.tuned.recallAtK} vs mean ${meanRecall.toFixed(4)} (drop ${recallDropFromMean} > ${recallThreshold})`,
        );
      }

      if (mrrDropFromMean > mrrThreshold) {
        failures.push(
          `trend mrr drop vs rolling-${comparable.length} mean too high: ${run.tuned.mrr} vs mean ${meanMrr.toFixed(4)} (drop ${mrrDropFromMean} > ${mrrThreshold})`,
        );
      }
    }
  }

  return failures;
}
