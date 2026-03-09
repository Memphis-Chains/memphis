# Retrieval Benchmark (v0.2.0 batch)

Dataset: `data/retrieval-benchmark-baseline.json`  
Harness: `scripts/retrieval-benchmark.ts` (`npm run bench:retrieval`)

## Metrics snapshot (k=3)

- Baseline (plain search)
  - Precision@3: **0.2000**
  - Recall@3: **0.6000**
  - MRR: **0.2333**

- Tuned (normalized query + lexical overlap boost)
  - Precision@3: **0.2667**
  - Recall@3: **0.8000**
  - MRR: **0.5667**

## Delta

- Precision@3: **+0.0667**
- Recall@3: **+0.2000**
- MRR: **+0.3334**

## Notes

- This is a pragmatic baseline harness for retrieval quality trending.
- Next step: add larger corpus, negative cases, and CI trend gates.
