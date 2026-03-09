import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  maxRecallDropFromRollingMean: 0.025,
  maxMrrDropFromRollingMean: 0.035,
  rollingWindow: 5,
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
  ...evaluateTrendGate(
    previous,
    out,
    {
      maxRecallDropFromPrevious: thresholds.maxRecallDropFromPrevious,
      maxMrrDropFromPrevious: thresholds.maxMrrDropFromPrevious,
      maxRecallDropFromRollingMean: thresholds.maxRecallDropFromRollingMean,
      maxMrrDropFromRollingMean: thresholds.maxMrrDropFromRollingMean,
      rollingWindow: thresholds.rollingWindow,
    },
    history,
  ),
);

if (process.env.RETRIEVAL_BENCH_WRITE_HISTORY?.toLowerCase() !== 'false') {
  saveHistory(historyPath, appendHistory(history, out));
}

const payload = {
  ok: failures.length === 0,
  failures,
  thresholds,
  metrics: out,
  previous: previous ?? null,
  historyPath,
};

const reportDir = resolve(process.env.RETRIEVAL_BENCH_REPORT_DIR ?? 'data/retrieval-benchmark-reports');
mkdirSync(reportDir, { recursive: true });
writeFileSync(resolve(reportDir, 'latest.json'), JSON.stringify(payload, null, 2));

const markdown = [
  '# Retrieval Benchmark Gate Report',
  '',
  `- status: **${payload.ok ? 'PASS' : 'FAIL'}**`,
  `- dataset: ${out.datasetPath}`,
  `- k: ${out.k}`,
  `- tuned recall@k: ${out.tuned.recallAtK}`,
  `- tuned mrr: ${out.tuned.mrr}`,
  `- delta recall@k: ${out.delta.recallAtK}`,
  `- previous tuned recall@k: ${previous?.tuned.recallAtK ?? 'n/a'}`,
  `- previous tuned mrr: ${previous?.tuned.mrr ?? 'n/a'}`,
  '',
  '## Failures',
  ...(failures.length > 0 ? failures.map((f) => `- ${f}`) : ['- none']),
  '',
  '## Artifacts',
  `- history: ${historyPath}`,
  `- report json: ${resolve(reportDir, 'latest.json')}`,
].join('\n');
writeFileSync(resolve(reportDir, 'latest.md'), markdown);

if (!payload.ok) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(payload, null, 2));
