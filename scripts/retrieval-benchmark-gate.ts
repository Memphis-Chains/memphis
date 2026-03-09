import { execSync } from 'node:child_process';

type Bench = {
  tuned: { precisionAtK: number; recallAtK: number; mrr: number };
  baseline: { precisionAtK: number; recallAtK: number; mrr: number };
  delta: { precisionAtK: number; recallAtK: number; mrr: number };
};

const raw = execSync('tsx scripts/retrieval-benchmark.ts 3 data/retrieval-benchmark-corpus-v2.json', {
  encoding: 'utf8',
});

const out = JSON.parse(raw) as Bench;

const thresholds = {
  minTunedRecall: 0.5,
  minTunedMrr: 0.35,
  minDeltaRecall: 0.03,
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

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures, metrics: out }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, thresholds, metrics: out }, null, 2));
