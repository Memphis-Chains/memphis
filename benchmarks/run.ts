import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendDecisionHistory } from '../src/core/decision-history-store.ts';
import { runImportJsonPayload, type NormalizedChainBlock } from '../src/infra/cli/import-json.ts';
import { OrchestrationService } from '../src/modules/orchestration/service.ts';
import { LocalFallbackProvider } from '../src/providers/local-fallback/adapter.ts';

type BenchmarkKey = 'chain_write' | 'embed_search' | 'ask_request' | 'import';

type BenchResult = {
  key: BenchmarkKey;
  unit: 'entries/sec' | 'ms avg';
  value: number;
};

type Baseline = Record<BenchmarkKey, number>;

type RunMode = 'run' | 'check' | 'baseline:update';

const BASELINE_PATH = resolve('benchmarks/baseline.json');
const PERF_DIR = resolve('data/perf-bench');
const REGRESSION_THRESHOLD = 20;
const REGRESSION_EPSILON_PCT = 10; // Allow extra variance for CI environment differences

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function round(value: number, digits = 2): number {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function fmtDeltaPct(curr: number, baseline: number): string {
  if (baseline === 0) return '+0%';
  const raw = ((curr - baseline) / baseline) * 100;
  const sign = raw >= 0 ? '+' : '';
  return `${sign}${Math.round(raw)}%`;
}

function isRegression(key: BenchmarkKey, current: number, baseline: number): boolean {
  if (baseline <= 0) return false;
  if (key === 'embed_search' || key === 'ask_request') {
    const increasePct = ((current - baseline) / baseline) * 100;
    return increasePct > REGRESSION_THRESHOLD + REGRESSION_EPSILON_PCT;
  }

  const dropPct = ((baseline - current) / baseline) * 100;
  return dropPct > REGRESSION_THRESHOLD + REGRESSION_EPSILON_PCT;
}

function buildDecision(i: number) {
  const now = new Date().toISOString();
  return {
    id: `dec-${i}`,
    title: `Decision ${i}`,
    context: `Context for decision ${i}`,
    options: ['option-a', 'option-b', 'option-c'],
    chosen: 'option-a',
    confidence: 0.75,
    status: 'proposed' as const,
    schemaVersion: 1 as const,
    createdAt: now,
    updatedAt: now,
  };
}

function benchChainWrite(): BenchResult {
  mkdirSync(PERF_DIR, { recursive: true });
  const path = resolve(PERF_DIR, `decision-history-${randomUUID()}.jsonl`);
  const iterations = 1500;

  const started = nowMs();
  for (let i = 0; i < iterations; i += 1) {
    appendDecisionHistory(buildDecision(i), { path, correlationId: `corr-${i}` });
  }
  const elapsedSec = Math.max((nowMs() - started) / 1000, 0.0001);
  rmSync(path, { force: true });

  return {
    key: 'chain_write',
    unit: 'entries/sec',
    value: round(iterations / elapsedSec, 2),
  };
}

function deterministicEmbed(text: string, dim = 32): number[] {
  const out = new Array<number>(dim).fill(0);
  const bytes = Buffer.from(text, 'utf8');
  for (let i = 0; i < bytes.length; i += 1) {
    const lane = i % dim;
    const signal = (bytes[i]! ^ ((i * 31) >>> 0)) >>> 0;
    out[lane] += signal;
  }
  const norm = Math.sqrt(out.reduce((a, b) => a + b * b, 0));
  return norm > 0 ? out.map((v) => v / norm) : out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function benchEmbedSearch(): BenchResult {
  const docs = Array.from({ length: 1200 }, (_, i) => {
    const text = `memphis benchmark document ${i} contains memory chain context retrieval tags ${i % 13}`;
    return { id: `doc-${i}`, vec: deterministicEmbed(text) };
  });

  const queryCount = 80;
  const started = nowMs();

  for (let q = 0; q < queryCount; q += 1) {
    const qv = deterministicEmbed(`memory retrieval question ${q % 17}`);
    const ranked = docs
      .map((doc) => ({ id: doc.id, score: cosine(qv, doc.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    if (ranked.length === 0) {
      throw new Error('embed_search benchmark failed: empty ranking');
    }
  }

  const elapsedMs = Math.max(nowMs() - started, 0.001);
  return {
    key: 'embed_search',
    unit: 'ms avg',
    value: round(elapsedMs / queryCount, 2),
  };
}

async function benchAskRequest(): Promise<BenchResult> {
  const orchestrator = new OrchestrationService({
    defaultProvider: 'local-fallback',
    providers: [new LocalFallbackProvider()],
    maxRetries: 0,
  });

  const requests = 120;
  const started = nowMs();

  for (let i = 0; i < requests; i += 1) {
    await orchestrator.generate({ input: `Benchmark ask request ${i}` });
  }

  const elapsedMs = Math.max(nowMs() - started, 0.001);
  return {
    key: 'ask_request',
    unit: 'ms avg',
    value: round(elapsedMs / requests, 2),
  };
}

function makeImportPayload(count: number): { blocks: NormalizedChainBlock[] } {
  const blocks: NormalizedChainBlock[] = [];
  for (let i = 0; i < count; i += 1) {
    const prev = i === 0 ? '0'.repeat(64) : blocks[i - 1]!.hash;
    blocks.push({
      index: i,
      prev_hash: prev,
      hash: `${String(i).padStart(63, 'a')}b`,
      timestamp: new Date().toISOString(),
      chain: 'benchmark',
      data: { type: 'note', content: `Imported benchmark block ${i}`, tags: ['bench', 'import'] },
    });
  }
  return { blocks };
}

function benchImportThroughput(): BenchResult {
  const entries = 2500;
  const payload = makeImportPayload(entries);

  const started = nowMs();
  const out = runImportJsonPayload(payload);
  const elapsedSec = Math.max((nowMs() - started) / 1000, 0.0001);

  if (out.imported <= 0) {
    throw new Error('import benchmark failed: nothing imported');
  }

  return {
    key: 'import',
    unit: 'entries/sec',
    value: round(out.imported / elapsedSec, 2),
  };
}

async function runBenchmarks(): Promise<BenchResult[]> {
  return [benchChainWrite(), benchEmbedSearch(), await benchAskRequest(), benchImportThroughput()];
}

function loadBaseline(): Baseline | null {
  try {
    const raw = readFileSync(BASELINE_PATH, 'utf8');
    return JSON.parse(raw) as Baseline;
  } catch {
    return null;
  }
}

function saveBaseline(results: BenchResult[]): void {
  mkdirSync(resolve('benchmarks'), { recursive: true });
  const payload = Object.fromEntries(results.map((r) => [r.key, r.value])) as Baseline;
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function printReport(results: BenchResult[], baseline: Baseline | null): number {
  console.log('Benchmark Results');
  console.log('=================');

  let regressions = 0;
  for (const result of results) {
    const base = baseline?.[result.key];
    if (typeof base === 'number') {
      const delta = fmtDeltaPct(result.value, base);
      const reg = isRegression(result.key, result.value, base);
      if (reg) regressions += 1;
      const warn = reg ? ' ⚠️' : '';
      const metricLabel = result.unit === 'ms avg' ? `${result.value}ms avg` : `${result.value} entries/sec`;
      const baseLabel = result.unit === 'ms avg' ? `${base}ms` : `${base}`;
      console.log(`${result.key}: ${metricLabel} (baseline: ${baseLabel}, ${delta}${warn})`);
    } else {
      const metricLabel = result.unit === 'ms avg' ? `${result.value}ms avg` : `${result.value} entries/sec`;
      console.log(`${result.key}: ${metricLabel} (baseline: n/a)`);
    }
  }

  console.log('');
  const noun = regressions === 1 ? 'regression' : 'regressions';
  console.log(`Status: ${regressions} ${noun} detected`);
  return regressions;
}

async function main() {
  const mode = (process.argv[2] as RunMode | undefined) ?? 'run';
  const results = await runBenchmarks();

  if (mode === 'baseline:update') {
    saveBaseline(results);
  }

  const baseline = loadBaseline();
  const regressions = printReport(results, baseline);

  if (mode === 'check' && regressions > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(msg);
  process.exit(1);
});
