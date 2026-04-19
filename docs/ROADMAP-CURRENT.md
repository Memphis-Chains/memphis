# Memphis Current Roadmap

Updated: 2026-03-28

## Why This Roadmap Exists

Memphis moved fast over the last month and accumulated too many competing
stories about what had shipped, what was only partially repaired, and what was
still aspirational. This document is the canonical roadmap for the current
phase after `v1.0.1`.

It replaces informal interpretation of older roadmap files. Historical roadmap
artifacts still exist for auditability, but they are not the current plan.

## The Last Month: What Actually Happened

The month-long arc looked like this:

1. Memphis started from a fragmented state: multiple roadmap narratives,
   divergent operator surfaces, legacy TUI baggage, mixed release/install
   stories, and incomplete runtime convergence.
2. The core runtime was then progressively unified around local-first,
   chain-first behavior: one turn runtime, one memory truth, one release path,
   and one native Rust operator console.
3. `v1.0.0` and `v1.0.1` were cut after the core runtime, release gates, and
   source-first install path became coherent enough to ship.
4. After that, a critical truth gap became clear: first-run and onboarding were
   not trustworthy enough, and the repo docs still mixed product truth with old
   internal narratives.
5. The current phase began as a recovery-and-truth phase: controlled `init`,
   explicit first-state creation, legacy-state detection, and documentation
   correction.

## What Is Already Done

- chain-first runtime and memory are the product core
- CLI, HTTP, MCP, and Rust TUI share the core runtime contract
- Rust TUI replaced the old TypeScript TUI as the active native console
- release and CI gates are real and enforced
- `bootstrap -> init` is now the intended first-run contract
- legacy roadmap files have been demoted from active product truth

## Where We Are Now

Memphis is in a **stabilization and trust-consolidation phase**.

That means:

- do not expand features just to make the roadmap look bigger
- do make the current product easier to trust, install, understand, and operate
- do keep documentation, release status, and runtime behavior aligned

## Current Milestones

### M1. Documentation and public truth closure

Goal:

- make the repo tell the full truth on `main`

Outcomes:

- rewritten public README
- canonical current-status doc
- canonical current-roadmap doc
- release/publication truth clarified after `v1.0.1`
- Apache-2.0 made explicit and mechanically verified

### M2. First-run quality and operator trust

Goal:

- make `init` feel intentional and reviewable, not just technically correct

Outcomes:

- better guided-conversation quality
- clearer first-state preview and reporting
- simpler operator language around identity, memory, and chain creation

### M3. Legacy-state and migration hardening

Goal:

- make older local runtime state fail early and recover clearly

Outcomes:

- more reliable legacy detection
- bounded normalization/migration paths
- fewer “late crash” scenarios during normal use

### M4. Rust TUI onboarding phase

Goal:

- bring the controlled first-run flow into the next TUI generation without
  wasting work on the current renderer layer

Outcomes:

- shared onboarding state machine reused by future TUI work
- ratatui-connected TUI onboarding later, not during the current docs/trust
  phase

### M5. Post-core polish and optional surfaces

Goal:

- harden optional channels and polish operator experience only after the core
  product story is stable

Outcomes:

- bounded optional channel improvements
- remaining legacy/debug cleanup
- packaging/distribution clarity

### M6. Embedding cascade unification (sovereign RAG stack)

Goal:

- unify `memphis-embed` into a multi-tier cascade that runs native on any
  x86_64 CPU since ~2011, keeps optional local GPU and optional remote
  providers as opt-in tiers, and exposes the same stack to the self-hosted
  RAG sidecar (synjar fork) via NAPI instead of duplicated HTTP plumbing.

Why now:

- The sovereign-RAG stack was proven end-to-end on 2026-04-19 on a decade-old
  i3-2120 box with no GPU and no internet: 68 docs ingested, 797 chunks,
  cross-lingual semantic search verified. That run is the lower hardware
  bound for Memphis and becomes the mandated last-fallback tier.
- The synjar fork currently re-implements Ollama HTTP plumbing that
  duplicates logic already present in `crates/memphis-embed`. Unifying them
  behind a Rust-native cascade removes the duplication, removes the HTTP
  hop, and makes the fallback behavior a single codepath.

Outcomes:

- `OnnxLocalProvider` in `crates/memphis-embed` using `ort` + a pre-shipped
  `multilingual-e5-small` ONNX model (117 MB) with `all-MiniLM-L6-v2` (23 MB)
  as the minimum-install fallback — both real semantic embeddings, not the
  current hash-based `LocalDeterministicProvider`.
- `CascadeProvider` that stitches `OnnxLocalProvider` (Tier 0, always
  available) with `OllamaProvider` (Tier 1, auto-detected) and the existing
  `GenericOpenAIProvider` family (Tier 2, explicit opt-in via
  `allow_remote = true`).
- Hardware auto-detection on init so the pipeline picks the best available
  tier without operator config (CUDA → Ollama GPU; CPU+AVX2 → ONNX; neither
  → MiniLM-L6 last-fallback).
- `memphis-napi` exposes cascade-aware `embed_store` / `embed_search` to
  TypeScript surfaces; synjar's `IEmbeddingsService` switches from its own
  Ollama HTTP adapter to a thin NAPI-consumer class.
- Blueprint-driven config (`embeddings.cascade`) as the pilot migration for
  the Blueprint Config System — one source of truth drives the GUI form, the
  runtime validator, the MCP tool schema, and the operator docs.
- `curl | bash` one-liner install pulls the minimum ONNX model during
  bootstrap so Memphis has real semantic embeddings out of the box, even on
  air-gapped hardware.

Detailed plan: `/home/memphis/_Watra/_embedding-cascade-plan.md` (local,
gitignored) — 4 sprints, acceptance criteria, risk register, integration
points with Phase B (Blueprint), Phase T (Trust chains), and Phase G (GUI).

## Explicitly Deferred

These are not current blockers and should not outrun the stabilization phase:

- broad provider expansion
- federation as a core dependency
- OpenClaw revival
- “AI slop” feature growth without operator-trust payoff
- large Rust TUI UX expansion before the ratatui-connected phase

## Historical Pointers

Older files remain as historical records:

- `ROADMAP.md`
- `ROADMAP-MASTER-QUEUE.md`
- `docs/archive/2026-04-14-post-roadmap-cleanup/ROADMAP-FULL-SPRINT3-TO-M8.md` (archived 2026-04-14)
- `docs/EXECUTION-PLAN.md`

Use them to understand how Memphis got here, not to decide what happens next.
