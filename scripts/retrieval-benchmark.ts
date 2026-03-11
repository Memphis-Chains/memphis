import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Dataset = {
  docs: Array<{ id: string; text: string }>;
  cases: Array<{ query: string; relevant: string[] }>;
};

export type Metrics = { precisionAtK: number; recallAtK: number; mrr: number };

export type BenchmarkOutput = {
  k: number;
  datasetPath: string;
  cases: number;
  baseline: Metrics;
  tuned: Metrics;
  delta: Metrics;
  fallbackUsed?: boolean;
};

type IndexedDoc = {
  id: string;
  embedding: number[];
  normalizedText: string;
};

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'for',
  'of',
  'to',
  'in',
  'on',
  'is',
  'are',
  'with',
  'how',
]);

const EMBEDDED_FALLBACK_DATASET: Dataset = {
  docs: [
    {
      id: 'doc_publish_v5',
      text: 'Memphis v5 publishing checklist includes docs, changelog, smoke tests, and package verification.',
    },
    {
      id: 'doc_security_posture',
      text: 'Security-first defaults require chain integrity checks, signed artifacts, and strict provider policy.',
    },
    {
      id: 'doc_agent_handoff',
      text: 'Codex agent handoff should include context summary, constraints, and verification commands.',
    },
    {
      id: 'doc_benchmark_gate',
      text: 'Retrieval benchmark gate tracks recall, MRR, and historical regression thresholds.',
    },
    {
      id: 'doc_refactor_cleanup',
      text: 'Refactor and cleanup focus on removing duplication, tightening types, and reducing repeated computation.',
    },
    {
      id: 'doc_memory_chain',
      text: 'Memory chain records decisions, links context, and supports fast recall for recent work.',
    },
  ],
  cases: [
    { query: 'v5 publishing workflow', relevant: ['doc_publish_v5'] },
    { query: 'security first defaults', relevant: ['doc_security_posture'] },
    { query: 'codex agents handoff context', relevant: ['doc_agent_handoff'] },
    { query: 'benchmark recall mrr gate', relevant: ['doc_benchmark_gate'] },
    { query: 'refactor cleanup duplication', relevant: ['doc_refactor_cleanup'] },
    { query: 'memory chain recall decisions', relevant: ['doc_memory_chain'] },
  ],
};

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

function normalizeQuery(input: string): string {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t))
    .join(' ');
}

function tokenizeNormalized(input: string): string[] {
  return input.split(/\s+/).filter(Boolean);
}

function lexicalOverlap(queryTokens: string[], normalizedDocText: string): number {
  if (queryTokens.length === 0) return 0;
  const hit = queryTokens.filter((t) => normalizedDocText.includes(t)).length;
  return hit / queryTokens.length;
}

function indexDocs(docs: Array<{ id: string; text: string }>): IndexedDoc[] {
  return docs.map((doc) => ({
    id: doc.id,
    embedding: deterministicEmbed(doc.text),
    normalizedText: normalizeQuery(doc.text),
  }));
}

function runSearch(
  docs: IndexedDoc[],
  query: string,
  k: number,
  tuned: boolean,
): string[] {
  const qRaw = deterministicEmbed(query);
  const qNormText = normalizeQuery(query);
  const qTokens = tokenizeNormalized(qNormText);
  const qNorm = qNormText.length > 0 ? deterministicEmbed(qNormText) : qRaw;

  return docs
    .map((d) => {
      const raw = cosine(qRaw, d.embedding);
      const s = tuned
        ? Math.max(raw, cosine(qNorm, d.embedding)) + 0.15 * lexicalOverlap(qTokens, d.normalizedText)
        : raw;
      return { id: d.id, score: s };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, k))
    .map((x) => x.id);
}

function avg(n: number, d: number): number {
  return d === 0 ? 0 : Number((n / d).toFixed(4));
}

function score(dataset: Dataset, k: number, tuned: boolean): Metrics {
  const indexedDocs = indexDocs(dataset.docs);
  let p = 0;
  let r = 0;
  let rr = 0;

  for (const c of dataset.cases) {
    const hitIds = runSearch(indexedDocs, c.query, k, tuned);
    const relevantSet = new Set(c.relevant);

    const tp = hitIds.filter((id) => relevantSet.has(id)).length;
    p += tp / Math.max(1, k);
    r += tp / Math.max(1, relevantSet.size);

    const rank = hitIds.findIndex((id) => relevantSet.has(id));
    rr += rank === -1 ? 0 : 1 / (rank + 1);
  }

  return {
    precisionAtK: avg(p, dataset.cases.length),
    recallAtK: avg(r, dataset.cases.length),
    mrr: avg(rr, dataset.cases.length),
  };
}

function loadDataset(datasetPath: string): { dataset: Dataset; fallbackUsed: boolean; datasetPath: string } {
  const resolvedPath = resolve(datasetPath);
  if (existsSync(resolvedPath)) {
    try {
      const parsed = JSON.parse(readFileSync(resolvedPath, 'utf8')) as Dataset;
      if (Array.isArray(parsed.docs) && Array.isArray(parsed.cases)) {
        return { dataset: parsed, fallbackUsed: false, datasetPath };
      }
    } catch {
      // Fall through to embedded fallback corpus.
    }
  }
  return {
    dataset: EMBEDDED_FALLBACK_DATASET,
    fallbackUsed: true,
    datasetPath: `${datasetPath}#embedded-fallback`,
  };
}

export function runBenchmark(k: number, datasetPath: string): BenchmarkOutput {
  const loaded = loadDataset(datasetPath);
  const dataset = loaded.dataset;
  const baseline = score(dataset, k, false);
  const tuned = score(dataset, k, true);
  return {
    k,
    datasetPath: loaded.datasetPath,
    cases: dataset.cases.length,
    baseline,
    tuned,
    delta: {
      precisionAtK: Number((tuned.precisionAtK - baseline.precisionAtK).toFixed(4)),
      recallAtK: Number((tuned.recallAtK - baseline.recallAtK).toFixed(4)),
      mrr: Number((tuned.mrr - baseline.mrr).toFixed(4)),
    },
    fallbackUsed: loaded.fallbackUsed,
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  const k = Number(process.argv[2] ?? '3');
  const datasetPath = process.argv[3] ?? 'data/retrieval-benchmark-corpus-v2.json';
  console.log(JSON.stringify(runBenchmark(k, datasetPath), null, 2));
}
