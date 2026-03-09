import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Dataset = {
  docs: Array<{ id: string; text: string }>;
  cases: Array<{ query: string; relevant: string[] }>;
};

type Metrics = { precisionAtK: number; recallAtK: number; mrr: number };

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
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'is', 'are', 'with', 'how']);
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !stop.has(t))
    .join(' ');
}

function lexicalOverlap(queryNormalized: string, text: string): number {
  if (!queryNormalized.trim()) return 0;
  const q = queryNormalized.split(/\s+/).filter(Boolean);
  const body = normalizeQuery(text);
  const hit = q.filter((t) => body.includes(t)).length;
  return q.length === 0 ? 0 : hit / q.length;
}

function runSearch(docs: Array<{ id: string; text: string }>, query: string, k: number, tuned: boolean): string[] {
  const qRaw = deterministicEmbed(query);
  const qNormText = normalizeQuery(query);
  const qNorm = qNormText.length > 0 ? deterministicEmbed(qNormText) : qRaw;

  return docs
    .map((d) => {
      const dv = deterministicEmbed(d.text);
      const raw = cosine(qRaw, dv);
      const s = tuned ? Math.max(raw, cosine(qNorm, dv)) + 0.15 * lexicalOverlap(qNormText, d.text) : raw;
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
  let p = 0;
  let r = 0;
  let rr = 0;

  for (const c of dataset.cases) {
    const hitIds = runSearch(dataset.docs, c.query, k, tuned);
    const relevantSet = new Set(c.relevant);

    const tp = hitIds.filter((id) => relevantSet.has(id)).length;
    p += tp / Math.max(1, k);
    r += tp / Math.max(1, relevantSet.size);

    const rank = hitIds.findIndex((id) => relevantSet.has(id));
    rr += rank === -1 ? 0 : 1 / (rank + 1);
  }

  return { precisionAtK: avg(p, dataset.cases.length), recallAtK: avg(r, dataset.cases.length), mrr: avg(rr, dataset.cases.length) };
}

const k = Number(process.argv[2] ?? '3');
const datasetPath = resolve(process.argv[3] ?? 'data/retrieval-benchmark-baseline.json');
const dataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as Dataset;
const baseline = score(dataset, k, false);
const tuned = score(dataset, k, true);

console.log(
  JSON.stringify(
    {
      k,
      cases: dataset.cases.length,
      baseline,
      tuned,
      delta: {
        precisionAtK: Number((tuned.precisionAtK - baseline.precisionAtK).toFixed(4)),
        recallAtK: Number((tuned.recallAtK - baseline.recallAtK).toFixed(4)),
        mrr: Number((tuned.mrr - baseline.mrr).toFixed(4)),
      },
    },
    null,
    2,
  ),
);
