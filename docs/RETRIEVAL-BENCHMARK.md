# Retrieval Benchmark (v0.2.0 batch)

- Baseline tiny dataset: `data/retrieval-benchmark-baseline.json`
- Expanded corpus: `data/retrieval-benchmark-corpus-v2.json`
- Harness: `scripts/retrieval-benchmark.ts`
- CI gate: `scripts/retrieval-benchmark-gate.ts` (`npm run bench:retrieval:gate`)

## Run locally

```bash
npm run bench:retrieval -- 3 data/retrieval-benchmark-corpus-v2.json
npm run bench:retrieval:gate
```

## CI trend gate policy

Current guardrails (k=3):
- tuned recall@k >= **0.50**
- tuned mrr >= **0.35**
- tuned-vs-baseline delta recall@k >= **+0.03**

This keeps tuned retrieval from silently regressing while preserving deterministic local runs.

## Notes

- Corpus v2 includes 20 docs + 20 query cases (multi-topic, some multi-relevant targets).
- Gate is intentionally conservative to prevent flaky fails but still detect meaningful drops.
- Next extension: per-domain slices + historical trend artifact upload in CI.
