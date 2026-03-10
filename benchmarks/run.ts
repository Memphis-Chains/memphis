import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runBenchmark } from '../scripts/retrieval-benchmark.ts';

type Baseline = {
  tunedRecallAtK: number;
  tunedMrr: number;
  updatedAt: string;
};

const baselinePath = resolve(process.env.BENCHMARK_BASELINE_PATH ?? 'data/retrieval-benchmark-baseline.json');
const threshold = 0.3;

const updateBaseline = process.argv.includes('--update-baseline');
const result = runBenchmark(3, 'data/retrieval-benchmark-corpus-v2.json');

const current: Baseline = {
  tunedRecallAtK: result.tuned.recallAtK,
  tunedMrr: result.tuned.mrr,
  updatedAt: new Date().toISOString(),
};

if (updateBaseline) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, mode: 'baseline-updated', baselinePath, baseline: current }, null, 2));
  process.exit(0);
}

let baseline: Baseline;
try {
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8')) as Partial<Baseline>;
  if (typeof parsed.tunedRecallAtK !== 'number' || typeof parsed.tunedMrr !== 'number') {
    throw new Error('invalid baseline shape');
  }
  baseline = {
    tunedRecallAtK: parsed.tunedRecallAtK,
    tunedMrr: parsed.tunedMrr,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
  };
} catch {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, mode: 'baseline-created', baselinePath, baseline: current }, null, 2));
  process.exit(0);
}

const recallDrop = baseline.tunedRecallAtK > 0 ? (baseline.tunedRecallAtK - current.tunedRecallAtK) / baseline.tunedRecallAtK : 0;
const mrrDrop = baseline.tunedMrr > 0 ? (baseline.tunedMrr - current.tunedMrr) / baseline.tunedMrr : 0;

const ok = recallDrop <= threshold && mrrDrop <= threshold;
const payload = {
  ok,
  threshold,
  baseline,
  current,
  drops: {
    recallDrop,
    mrrDrop,
  },
  workflow: {
    check: 'npx tsx benchmarks/run.ts',
    updateBaseline: 'npx tsx benchmarks/run.ts --update-baseline',
  },
};

console.log(JSON.stringify(payload, null, 2));
if (!ok) process.exit(1);
