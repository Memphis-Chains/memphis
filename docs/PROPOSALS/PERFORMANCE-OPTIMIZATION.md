# Proposal: Performance Optimization Program (Memphis v5)

**Status:** Draft  
**Target Window:** v0.3.0 → v1.0.0  
**Owner:** Core Platform Engineering

## 1) Executive summary

Memphis v5 currently demonstrates excellent query latency and healthy memory usage in beta baselines. The next growth phase requires moving from “fast enough now” to a repeatable, regression-resistant performance program that scales under enterprise and ecosystem load.

This proposal introduces a structured optimization roadmap focused on:

- p95/p99 latency discipline
- cold-start and indexing throughput improvements
- predictable memory behavior under sustained load
- CI-integrated performance regression prevention

## 2) Problem statement

Current benchmarks validate strong point-in-time performance, but performance governance is still partially manual and dataset-dependent. As feature surface expands (enterprise controls, integrations, plugins), the risk of silent regressions increases.

Without a formal optimization program, Memphis may face:

- latency drift across releases
- reduced operator trust in production predictability
- higher infrastructure cost due to inefficient resource usage
- delayed incident detection when workloads change

## 3) Current performance baseline

Based on `docs/TEST-REPORT-2026-03-11.md` and `docs/RETRIEVAL-BENCHMARK.md`:

### Query and runtime metrics

- Semantic query average: **0.32 ms**
- Semantic query max: **0.49 ms**
- Tuned query average: **0.74 ms**
- Tuned query max: **0.81 ms**
- Filesystem fallback: **6.23 ms**
- RSS memory: **82.09 MB**

### Benchmark governance metrics

- Retrieval gate guardrails in CI:
  - recall@k >= **0.50**
  - MRR >= **0.35**
  - tuned-vs-baseline recall delta >= **+0.03**
- Known tooling gap:
  - `bench:retrieval` failure due to dataset contract mismatch (`dataset.cases is not iterable`)

## 4) Optimization opportunities

1. **Benchmark reliability and representativeness**
   - Expand datasets to include larger corpora and adversarial retrieval cases.
   - Add deterministic seed and environment normalization to reduce false variance.

2. **Tail latency control (p95/p99)**
   - Current reports focus on avg/max; production readiness needs percentile SLAs.

3. **Indexing throughput and write path efficiency**
   - Anticipated scale requires faster ingest/re-index operations with bounded memory growth.

4. **Cold start and initialization overhead**
   - Improve startup time for CLI/server/MCP modes to reduce operator friction.

5. **Memory lifecycle optimization**
   - Reduce long-session heap drift and fragmentation through better cache policy.

## 5) Proposed improvements

## A. Performance SLO framework

Define platform SLOs and enforce in CI + release gates:

- Query latency: p95 < 5 ms, p99 < 20 ms (local baseline profile)
- Cold start: < 1.5 s for standard CLI runtime
- Index throughput: +50% vs v0.2 baseline on reference corpus
- Memory ceiling: RSS < 120 MB on standard mixed workload

## B. Tiered benchmark suite

Create three benchmark tiers:

- **Tier 1 (PR gate):** fast deterministic micro-benchmarks
- **Tier 2 (nightly):** representative end-to-end scenarios
- **Tier 3 (pre-release):** stress/soak and scale tests

Outcome: faster feedback in PRs and stronger pre-release confidence.

## C. Retrieval and indexing engine improvements

- Normalize dataset schema and harden loader contracts.
- Introduce adaptive top-k and query-plan heuristics for mixed workloads.
- Improve batching/vectorization in indexing path.
- Add optional incremental index compaction schedule.

## D. Runtime resource controls

- Introduce configurable cache policies (size + eviction strategy).
- Add memory pressure telemetry and automatic throttle mode for heavy ingest.
- Add optional “performance profile” presets (`dev`, `prod`, `low-memory`).

## E. Observability enhancement

- Emit structured latency histograms (p50/p95/p99) and key counters.
- Publish performance dashboard artifact per release candidate.

## 6) Expected impact

### Quantitative targets

- **30–50% improvement** in indexing throughput on benchmark corpus
- **40% reduction** in p99 latency variance under mixed workloads
- **20–30% reduction** in cold-start time
- **Near-zero benchmark false failures** from data contract and env drift

### Qualitative outcomes

- Increased confidence for enterprise evaluation
- Stronger release gating and lower regression risk
- Better operational clarity for incident triage

## 7) Implementation plan

## Phase 1 (2 weeks): Baseline hardening

- Fix benchmark data-contract mismatch.
- Define and codify SLO metrics (including p95/p99).
- Add benchmark metadata (hardware/env fingerprint).

**Resources:** 1 platform engineer, 0.25 QA support

## Phase 2 (3–4 weeks): Engine and runtime optimization

- Apply indexing/path optimizations and cache policy controls.
- Add cold-start instrumentation and startup optimizations.
- Validate on nightly benchmark suites.

**Resources:** 2 platform engineers, 0.5 QA support

## Phase 3 (2 weeks): Release-gate integration

- Integrate tiered benchmarks into CI/release templates.
- Add performance dashboard to release artifacts.
- Finalize runbook for regression response.

**Resources:** 1 platform engineer, 0.25 DevOps support

**Total estimate:** 7–8 weeks, ~3.5–4.0 engineering person-months.

## 8) Risks and mitigations

- **Risk:** Over-optimization for synthetic benchmarks  
  **Mitigation:** Use mixed realistic corpora and production-like traces.

- **Risk:** Increased complexity in runtime profiles  
  **Mitigation:** Start with minimal preset set and sane defaults.

- **Risk:** CI duration growth from benchmark tiers  
  **Mitigation:** Keep Tier 1 lightweight; defer heavy suites to nightly/pre-release.

- **Risk:** Latency wins with memory regressions (or vice versa)  
  **Mitigation:** Use multi-metric gates (latency + memory + throughput).

## 9) Success metrics

This proposal is successful when, for 2 consecutive minor releases:

- SLO targets are met in release gates.
- No high-severity performance regressions reach GA.
- Benchmark suite runs deterministically in CI (<=2% flaky rate).
- Operator-reported performance incidents decrease by >=30%.

## 10) Decision request

Approve creation of a formal performance program for v0.3.0–v1.0.0 with dedicated engineering allocation and CI gate adoption.
