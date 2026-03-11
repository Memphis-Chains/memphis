# Memphis v5 — Full Performance Analysis Report

Date: 2026-03-11  
Repo: `/home/memphis_ai_brain_on_chain/memphis-v5`  
Baseline noted: ~0.32ms avg query (likely warm-cache semantic query path)

## Executive Summary

Memphis v5 is already fast on the happy-path benchmark, but there are multiple structural bottlenecks that will surface with scale (more chain blocks, more docs, more agents, higher concurrency).

I identified **18 concrete improvement opportunities** across hot paths, memory, I/O, algorithmic complexity, and async/concurrency.

Top risks:

1. **Repeated full-chain load + full JSON serialization into NAPI** for append/query.
2. **O(N log N) full-sort search** in embed pipeline where top-K selection would suffice.
3. **Synchronous filesystem writes/reads** in hot operational paths (sessions, sync ledger, registries).
4. **Global mutex serialization for embed operations** in Rust bridge (limits parallel throughput).
5. **O(N²) contradiction detection** in Model E and repeated rescans in cognitive analyzers.

---

## 1) Hot Paths (query execution, chain ops, embedding, search, sync)

## H1 — Full chain load from disk for each chain operation

- **Where**: `src/infra/storage/rust-chain-adapter.ts` (`readChainBlocks` used by `appendBlock`, `queryBlocks`, `getRecentBlocks`)
- **Issue**: Every operation scans directory, loads all JSON files, parses all blocks.
- **Impact**: O(N) disk + parse overhead per request; latency grows linearly with chain size.
- **Optimization**:
  - Keep in-memory append-only index per chain (with periodic refresh/invalidation).
  - Maintain `latest-block` metadata file for O(1) next index/prev hash.
  - For `getRecentBlocks`, read only tail files, not full chain.

## H2 — NAPI chain_append/query serialize entire chain payload each call

- **Where**: `src/infra/storage/rust-chain-adapter.ts` + `crates/memphis-napi/src/lib.rs` (`chain_append`, `chain_query`)
- **Issue**: TS sends full `JSON.stringify(chainBlocks)` into Rust; Rust re-parses full vector.
- **Impact**: Double serialization/parsing + memory copy amplification; expensive at larger N.
- **Optimization**:
  - Move chain state ownership to Rust side (stateful store handle).
  - NAPI API should pass only delta (`newBlock`) or query parameters.
  - If stateless must remain: use compact binary format (or JSON Lines stream with incremental parse).

## H3 — chain_query does repeated lowercase allocations per block

- **Where**: `crates/memphis-napi/src/lib.rs` (`chain_query` filter)
- **Issue**: `b.data.content.to_lowercase()` and per-tag `to_lowercase()` inside filter loop.
- **Impact**: High transient allocations/CPU for frequent queries.
- **Optimization**:
  - Normalize content/tags at ingest and store lowercase sidecar fields.
  - Use ASCII case-insensitive compare where possible.

## H4 — Embed search sorts all documents instead of top-K select

- **Where**: `crates/memphis-embed/src/pipeline.rs` (`search`, `search_tuned`)
- **Issue**: Build full `hits` vector for all docs, full sort, then truncate.
- **Impact**: O(N log N) vs achievable O(N log K), memory overhead proportional to N.
- **Optimization**:
  - Use fixed-size min-heap for top-K.
  - Return borrowed ids/previews where possible to reduce cloning.

## H5 — Tuned search adds lexical overlap with substring scan per token

- **Where**: `crates/memphis-embed/src/pipeline.rs` (`lexical_overlap`)
- **Issue**: For each query token, `body.contains(token)` over full normalized text.
- **Impact**: Potential O(Q \* text_len) per doc, repeated for all docs.
- **Optimization**:
  - Tokenize doc once and store `HashSet<String>` (or bloom filter) for membership checks.
  - Consider BM25-style sparse index for lexical rerank stage.

## H6 — Sync push sends full chain to every agent (fan-out payload explosion)

- **Where**: `src/sync/sync-manager.ts` (`push`)
- **Issue**: Same full `blocks` array sent to each peer.
- **Impact**: O(A \* N) serialization/network cost; high bandwidth and GC pressure.
- **Optimization**:
  - Delta sync by last-known hash/index per peer.
  - Compress payload (gzip/deflate) for larger sync batches.

---

## 2) Memory Usage

## M1 — Full-chain materialization in memory during append/query

- **Where**: `rust-chain-adapter.ts` + NAPI `chain_append`/`chain_query`
- **Issue**: Chain fully loaded in JS arrays + fully deserialized again in Rust.
- **Impact**: 2x memory amplification, spikes with chain size.
- **Optimization**: Single ownership model (Rust or TS), incremental append/query over indexed store.

## M2 — UsageTracker grows unbounded

- **Where**: `src/providers/dynamic-router.ts` (`UsageTracker.routings`)
- **Issue**: Array never pruned.
- **Impact**: Long-running process memory growth; degraded stats traversal performance.
- **Optimization**:
  - Ring buffer (e.g., last 10k records) or periodic aggregation + discard raw samples.

## M3 — Observability snapshot append rewrites full array each write

- **Where**: `src/tui/observability-store.ts`
- **Issue**: Load whole file + append + rewrite every snapshot.
- **Impact**: transient allocations and disk churn.
- **Optimization**:
  - JSONL append mode with bounded compaction job.
  - Or mmap-friendly binary log.

## M4 — Cache eviction in TS query cache is O(N)

- **Where**: `src/cache/query-cache.ts` (`evictOldest` linear scan)
- **Issue**: At capacity, every insert may scan all entries.
- **Impact**: Latency spikes when cache near max size.
- **Optimization**:
  - Real LRU (Map insertion-order bump + head eviction) or linked-hash strategy.

## M5 — Rust EmbeddingCache `retain` on every get/put is O(N)

- **Where**: `crates/memphis-embed/src/cache.rs`
- **Issue**: Access-order updates use `VecDeque::retain` repeatedly.
- **Impact**: Cache ops degrade with cache size.
- **Optimization**:
  - Use linked hash map / index map with O(1) touch and eviction.

---

## 3) I/O Bottlenecks

## I1 — Sync manager chain storage uses blocking FS in runtime path

- **Where**: `src/sync/sync-manager.ts`
- **Issue**: `readFileSync`/`writeFileSync` in pull/status flows.
- **Impact**: Event-loop stalls under concurrent sync operations.
- **Optimization**:
  - Switch to async fs APIs + write batching/debounce.

## I2 — NetworkChain appends by read-all + write-all each event

- **Where**: `src/sync/network-chain.ts`
- **Issue**: `append()` reads whole ledger then rewrites entire JSON.
- **Impact**: O(N) per append; strong degradation for large ledgers.
- **Optimization**:
  - JSONL append-only ledger + periodic compaction.

## I3 — Ask session store uses sync JSONL parsing of whole file

- **Where**: `src/core/ask-session-store.ts`
- **Issue**: `readAskSession` reads full session and parses all lines every call.
- **Impact**: session latency scales with history length; event-loop blocking.
- **Optimization**:
  - Async streaming tail-read for last K turns.
  - Maintain rolling token window index.

## I4 — Multiple registries use sync read/write full JSON files

- **Where**: `src/cognitive/agent-registry.ts`, `relationship-graph.ts`, `trust-metrics.ts`, `src/sync/agent-registry.ts`
- **Issue**: Frequent full-file rewrite for small mutations.
- **Impact**: I/O amplification and lock contention risk.
- **Optimization**:
  - Append-only WAL + periodic snapshot, or embedded KV store (sqlite/lmdb).

## I5 — NAPI bridge load repeated in adapter calls

- **Where**: `src/infra/storage/rust-embed-adapter.ts`, `rust-vault-adapter.ts`
- **Issue**: `getBridgeOrThrow()` calls `loadBridge()` repeatedly (dynamic require path).
- **Impact**: avoidable overhead and repeated module resolution checks.
- **Optimization**:
  - Cache bridge instance once (as in `NapiChainAdapter`) and reuse.

---

## 4) Algorithmic Complexity

## A1 — O(N²) contradiction detection in Model E

- **Where**: `src/cognitive/model-e.ts` (`detectContradictions` nested loops over decisions)
- **Issue**: pairwise comparison of decision blocks.
- **Impact**: explodes for large history windows.
- **Optimization**:
  - Index decisions by tag/category and compare only candidate buckets.
  - Sliding time window constraints to reduce candidate set.

## A2 — Multiple full rescans of same block set in reflection pipeline

- **Where**: `src/cognitive/model-e.ts` (`calculateStats`, `extractInsights`, `extractThemes`, `detectBlindSpots`)
- **Issue**: repeated passes and repeated timestamp parsing.
- **Impact**: constant-factor overhead significant with large datasets.
- **Optimization**:
  - Single-pass aggregation struct reused across analyzers.
  - Precompute parsed timestamp/hour/type/tag histograms.

## A3 — Dynamic provider selection repeatedly sorts arrays

- **Where**: `src/providers/dynamic-router.ts`
- **Issue**: candidate/model arrays sorted in-place on every route call.
- **Impact**: unnecessary O(P log P) churn for small but frequent routing decisions.
- **Optimization**:
  - Maintain pre-ranked providers by priority dimension; update on metric change.

## A4 — Stable stringify in diffing is expensive recursive canonicalization

- **Where**: `src/sync/chain-diff.ts`
- **Issue**: `stableStringify` recursively sorts object entries for fingerprints.
- **Impact**: CPU-heavy for deep block payloads.
- **Optimization**:
  - Persist canonical hash at block creation and compare hashes directly.
  - Fallback to deep compare only on hash mismatch.

---

## 5) Async / Concurrency

## C1 — Global Mutex serializes all embed store/search calls

- **Where**: `crates/memphis-napi/src/lib.rs` (`EMBED_PIPELINE: OnceLock<Mutex<EmbedPipeline>>`)
- **Issue**: single lock guards whole pipeline.
- **Impact**: throughput bottleneck under concurrent query load.
- **Optimization**:
  - Use `RwLock` (many readers for search, exclusive writers for upsert/reset).
  - Consider sharded index by document id hash.

## C2 — Sync push is strictly sequential per agent

- **Where**: `src/sync/sync-manager.ts` (`for..of` with await)
- **Issue**: one slow agent blocks others.
- **Impact**: tail latency and reduced sync throughput.
- **Optimization**:
  - Bounded concurrency pool (e.g., 4-8 in-flight requests).
  - Keep circuit-breaker/cooldown for failing peers.

## C3 — No backpressure/abort in websocket request handling

- **Where**: `src/sync/protocol.ts`
- **Issue**: no payload-size guard, no parse-error handling around `JSON.parse`, no AbortSignal integration.
- **Impact**: potential event-loop stalls and brittle behavior under malformed/large responses.
- **Optimization**:
  - Add max message size checks and guarded parse.
  - Add cancellation via AbortController and early socket close.

---

## Prioritized Optimization Plan

### P0 (highest ROI, immediate)

1. **Refactor chain append/query API to avoid full-chain JSON roundtrip** (H1, H2, M1).
2. **Switch embed search to top-K heap** (H4).
3. **Replace sync FS in sync/session hot paths with async + append-only logs** (I1, I2, I3).
4. **Use RwLock for embed pipeline** (C1).

### P1

5. Delta sync protocol (H6, C2).
6. Pre-normalized lowercase/index fields for query filters (H3).
7. Bound in-memory routing history and observability writes (M2, M3).

### P2

8. Model E complexity reductions (A1, A2).
9. Canonical hash strategy for chain diff (A4).
10. Better cache data structures in TS/Rust caches (M4, M5).

---

## Expected Impact (qualitative)

- **Latency stability at scale**: major improvement once full-chain load/serialization is removed.
- **Throughput**: significant gain for concurrent semantic search after `RwLock` + top-K heap.
- **Event-loop health**: better p95/p99 by replacing synchronous FS in runtime paths.
- **Memory footprint**: reduced transient spikes and long-run memory drift.

---

## Notes

- Current ~0.32ms average is likely measured on a warm, relatively small corpus path and does not represent worst-case growth behavior.
- Most issues are architectural scaling bottlenecks rather than micro-optimizations.
- The codebase is structurally clean enough to implement these improvements incrementally without major rewrites.
