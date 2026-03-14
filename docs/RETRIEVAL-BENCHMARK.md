# Retrieval Benchmark (v0.2.0 batch)

- Baseline tiny dataset: `data/retrieval-benchmark-baseline.json`
- Expanded corpus: `data/retrieval-benchmark-corpus-v3.json`
- Harness: `scripts/retrieval-benchmark.ts`
- CI gate: `scripts/retrieval-benchmark-gate.ts` (`npm run bench:retrieval:gate`)

## Run locally

```bash
npm run bench:retrieval -- 3 data/retrieval-benchmark-corpus-v3.json
npm run bench:retrieval:gate
```

## CI trend gate policy

Current guardrails (k=3):

- tuned recall@k >= **0.85**
- tuned mrr >= **0.80**
- tuned-vs-baseline delta recall@k >= **+0.18**

Historical guardrails (vs previous comparable history entry):

- tuned recall@k drop <= **0.02**
- tuned mrr drop <= **0.03**

History artifact:

- default: `data/retrieval-benchmark-history.json`
- override path: `RETRIEVAL_BENCH_HISTORY_PATH`
- disable append in read-only mode: `RETRIEVAL_BENCH_WRITE_HISTORY=false`

This keeps tuned retrieval from silently regressing while preserving deterministic local runs.

## Notes

- Corpus v3 includes 18 docs + 24 query cases for wider deterministic coverage.
- Gate thresholds were re-baselined for v3 to keep stronger signal and still avoid flaky fails.
- Gate is intentionally conservative to prevent flaky fails but still detect meaningful drops.
- Next extension: per-domain slices + optional branch-aware trend baselines.
