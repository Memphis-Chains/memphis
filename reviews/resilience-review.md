# Resilience & Infrastructure Review - Task #39 Report

## 1. SearchCache memory leak (no TTL, no max size)

**File:** `src/resilience/cache.ts`

**Fix:** Add TTL (5 min) and max size (1000 entries) with LRU eviction.

---

## 2. ResilienceManager rust stub

**File:** `src/resilience/fallback.ts`

Only 1/3 strategies works. Rust search always throws.

**Fix:** Remove stub or implement Rust bridge call.

---

## 3. HnswIndex - no tests, not integrated

**File:** `src/infra/embeddings/hnsw-index.ts`

**Decision:** Either integrate or remove dead code.

---

## 4. Duplicate SearchResult interfaces

**Files:** fallback.ts, cache.ts, ts-search.ts

**Fix:** Consolidate to `src/resilience/types.ts`.

---

## Summary

| Issue                       | Priority | Effort |
| --------------------------- | -------- | ------ |
| SearchCache memory leak     | High     | Low    |
| Duplicate SearchResult      | Medium   | Low    |
| ResilienceManager rust stub | Medium   | Low    |
| HnswIndex tests + decision  | Low      | Medium |
