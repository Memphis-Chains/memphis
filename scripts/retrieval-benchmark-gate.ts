import {
  appendHistory,
  evaluateTrendGate,
  historyPathFromEnv,
  latestComparable,
  loadHistory,
  saveHistory,
} from './retrieval-benchmark-history.ts';
import { runBenchmark } from './retrieval-benchmark.ts';

const out = runBenchmark(3, 'data/retrieval-benchmark-corpus-v2.json');

const thresholds = {
  minTunedRecall: 0.5,
  minTunedMrr: 0.35,
  minDeltaRecall: 0.03,
  maxRecallDropFromPrevious: 0.02,
  maxMrrDropFromPrevious: 0.03,
};

const failures: string[] = [];
if (out.tuned.recallAtK < thresholds.minTunedRecall) {
  failures.push(`tuned recall@k below threshold: ${out.tuned.recallAtK} < ${thresholds.minTunedRecall}`);
}
if (out.tuned.mrr < thresholds.minTunedMrr) {
  failures.push(`tuned mrr below threshold: ${out.tuned.mrr} < ${thresholds.minTunedMrr}`);
}
if (out.delta.recallAtK < thresholds.minDeltaRecall) {
  failures.push(`delta recall@k regression: ${out.delta.recallAtK} < ${thresholds.minDeltaRecall}`);
}

const historyPath = historyPathFromEnv();
const history = loadHistory(historyPath);
const previous = latestComparable(history, out);
failures.push(
  ...evaluateTrendGate(previous, out, {
    maxRecallDropFromPrevious: thresholds.maxRecallDropFromPrevious,
    maxMrrDropFromPrevious: thresholds.maxMrrDropFromPrevious,
  }),
);

if (process.env.RETRIEVAL_BENCH_WRITE_HISTORY?.toLowerCase() !== 'false') {
  saveHistory(historyPath, appendHistory(history, out));
}

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      { ok: false, failures, thresholds, metrics: out, previous: previous ?? null, historyPath },
      null,
      2,
    ),
  );
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, thresholds, metrics: out, previous: previous ?? null, historyPath }, null, 2));
