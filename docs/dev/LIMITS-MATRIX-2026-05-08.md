# Memphis — Limits & Timeouts Matrix — 2026-05-08

**Spec for Phase 1.5** (`v1.8.2` — token/limit bumps).

This doc catalogs every artificial limit/timeout/budget in Memphis that can prematurely cut off a long-running reasoning task. Operator (post-Zawoja, 2026-05-08) directive: "Memphis must work 2 weeks on a single question; cost is irrelevant; limits are safety nets, not budgets."

**Reading order:** sections grouped by enforcement layer. Within each section: column **Current** = today's effective cap, **Source** = where it's defined, **Target** = Phase 1.5 v1.8.2 value, **Status** = enforcement mechanism (env-driven, hardcoded, schema-capped).

---

## §1. Critical Rust↔TS mismatches (silent caps)

These are the most dangerous — TS schema says X, Rust enforces Y < X. Bumping TS without Rust = no effect.

| Limit | TS schema cap | Rust runtime cap | Source TS | Source Rust | Target | Status |
|---|---|---|---|---|---|---|
| `max_tool_calls` | 64 (LOOP_LIMITS) | **16** | `src/gateway/loop-limits.ts:32` | `crates/memphis-core/src/loop_engine.rs:30` | **1024** | Rust enforces, TS misleading |
| `max_tokens` | 32,768 (schema) | **2,048** (hardcoded) | `src/infra/config/schema.ts:111` | `crates/memphis-operator/src/chat.rs:290` | **32,768** (env-driven via new `chat_max_tokens()`) | Rust enforces, hardcoded |
| `max_errors` | 4 (LOOP_LIMITS) | 8 (default) | `src/gateway/loop-limits.ts:34` | `crates/memphis-core/src/loop_engine.rs:32` | **32** | Drift, both raise |
| `max_steps` | 48 (LOOP_LIMITS) | 48 (env-overridable via `MEMPHIS_CHAT_MAX_STEPS`) | `src/gateway/loop-limits.ts:31` | `crates/memphis-core/src/loop_engine.rs:29`, `crates/memphis-operator/src/chat.rs:60` | **1000** | env-driven, raise default |

**PR 1.5.1** addresses these via `chat_max_tokens()` helper in `chat.rs` + bump default constants in `loop_engine.rs` + sync `loop-limits.ts` + add parity test (`tests/unit/loop-limits-parity.test.ts`) that fails on future drift.

---

## §2. Generation (LLM) limits

| Limit | Current | Source | Target | Status |
|---|---|---|---|---|
| `GEN_TIMEOUT_MS` schema | 90,000 default / 120,000 max | `src/infra/config/schema.ts:110` | **3,600,000 default / 86,400,000 max** | env-driven, raise |
| `GEN_MAX_TOKENS` schema | 4,096 default / 32,768 max | `src/infra/config/schema.ts:111` | **32,768 default / 1,048,576 max** | env-driven, raise |
| Per-mode token caps (cognitive) | fast=1024, deliberate=4096, meta=2048, default=2048 | `src/cognitive/mode-dispatch.ts:27-33` | env-overridden via `GEN_MAX_TOKENS` already (PR #494); raise base defaults to 4096/16384/8192/8192 | env-driven via `MEMPHIS_GEN_MAX_TOKENS` |

---

## §3. MiniMax SSE timeout (the live bug)

| Limit | Current | Source | Target | Status |
|---|---|---|---|---|
| MiniMax request timeout | **none** (default fetch behavior) | `src/providers/index.ts` MiniMax client | **`MINIMAX_REQUEST_TIMEOUT_MS=1_800_000` (30 min) default** | NEW env-driven |
| Ollama request timeout | 300,000 default / 3,600,000 max | `src/infra/config/schema.ts:88` (`OLLAMA_REQUEST_TIMEOUT_MS`) | unchanged (already 5min default) | env-driven |
| Embed provider timeout | 8,000 default / 60,000 max | `src/infra/config/schema.ts:174` (`RUST_EMBED_PROVIDER_TIMEOUT_MS`) | **bump to 60s default / 600s max** | env-driven, raise |
| GLM timeout | 30,000 default | `src/providers/glm/adapter.ts:15` | unchanged for now | env-driven via `GLM_TIMEOUT_MS` |

**PR 1.4 + PR 1.5.2** address MiniMax. **Live evidence**: 2 SSE timeouts on second TUI instance during the 2026-05-08 planning session.

---

## §4. Media/Voice timeouts (hardcoded — no env override)

All TS-only, no Rust counterpart. Hardcoded constants.

| Limit | Current | Source | Target |
|---|---|---|---|
| `STT_TIMEOUT_MS` | 90,000 (hardcoded, was 30s before #477) | `src/gateway/media/audio-adapter.ts:27` | **600,000 (env: `MEMPHIS_STT_TIMEOUT_MS`)** |
| `TTS_TIMEOUT_MS` (Piper) | 45,000 (hardcoded) | `src/gateway/voice/local-piper-adapter.ts:96` | **300,000 (env: `MEMPHIS_TTS_TIMEOUT_MS`)** |
| Piper health check | 5,000 (hardcoded) | `src/gateway/voice/local-piper-adapter.ts:148` | **30,000 (env: `MEMPHIS_PIPER_HEALTH_TIMEOUT_MS`)** |
| `FFMPEG_TIMEOUT_MS` | 30,000 (hardcoded) | `src/gateway/media/audio-adapter.ts:28` | **600,000 (env: `MEMPHIS_FFMPEG_TIMEOUT_MS`)** |
| `OCR_TIMEOUT_MS` | 90,000 (hardcoded) | `src/gateway/media/ocr-adapter.ts` ~:15 | **600,000 (env: `MEMPHIS_OCR_TIMEOUT_MS`)** |
| `VISION_TIMEOUT_MS` | 90,000 (hardcoded) | `src/gateway/media/vision-adapter.ts` ~:15 | **600,000 (env: `MEMPHIS_VISION_TIMEOUT_MS`)** |

---

## §5. MCP tool timeouts (hardcoded)

| Tool | Current | Source | Target |
|---|---|---|---|
| `web-fetch` | 8,000 | `src/mcp/tools/web-fetch.ts:7` | **60,000 (env: `MEMPHIS_WEB_FETCH_TIMEOUT_MS`)** |
| `brave-search` | 15,000 | `src/mcp/tools/brave-search.ts:23` | **60,000 (env: `MEMPHIS_BRAVE_SEARCH_TIMEOUT_MS`)** |
| `web-search` | 15,000 | `src/mcp/tools/web-search.ts:24` | **60,000 (env: `MEMPHIS_WEB_SEARCH_TIMEOUT_MS`)** |
| `exec` (bash) | 120,000 | `src/mcp/tools/exec.ts:6` | **3,600,000 (env: `MEMPHIS_EXEC_TIMEOUT_MS`)** |
| `build` | 300,000 | `src/mcp/tools/build.ts:31` | **7,200,000 (env: `MEMPHIS_BUILD_TIMEOUT_MS`)** |
| `package` (npm/cargo) | 120,000 | `src/mcp/tools/package.ts:30` | **3,600,000 (env: `MEMPHIS_PACKAGE_TIMEOUT_MS`)** |
| `health-check` | 5,000 default (configurable per-call) | `src/mcp/tools/health-check.ts:31` | unchanged |
| `send` (Telegram etc) | 10,000 | `src/mcp/tools/send.ts:53` | **60,000 (env: `MEMPHIS_SEND_TIMEOUT_MS`)** |
| `git` | 30,000 | `src/mcp/tools/git.ts:115` | **600,000 (env: `MEMPHIS_GIT_TIMEOUT_MS`)** |
| Custom tool HTTP | 30,000 max (schema 100–30,000 user override) | `src/mcp/server.ts:1240` | unchanged for now |

---

## §6. TUI host & protocol timeouts (Rust)

| Limit | Current | Source | Target |
|---|---|---|---|
| Host handshake | 20,000 (was 10s pre-#472) | `crates/memphis-tui/src/client.rs:33` | **120,000 (env: `MEMPHIS_TUI_HOST_HANDSHAKE_TIMEOUT_MS`)** |
| Host request start | 10,000 | `crates/memphis-tui/src/client.rs:34` | **60,000 (env: `MEMPHIS_TUI_HOST_REQUEST_START_TIMEOUT_MS`)** |
| Host request idle | 30,000 | `crates/memphis-tui/src/client.rs:35` | **1,800,000 (env: `MEMPHIS_TUI_HOST_REQUEST_IDLE_TIMEOUT_MS`)** |
| Host cancel | 2,000 | `crates/memphis-tui/src/client.rs:36` | unchanged (cancel should be fast) |

---

## §7. Cognitive mode + categorizer

| Limit | Current | Source | Target |
|---|---|---|---|
| Categorizer LLM call timeout | 3,000 (legacy `setTimeout` no withSpan) | `src/cognitive/categorizer.ts:307` | **60,000 (env: `MEMPHIS_CATEGORIZER_LLM_TIMEOUT_MS`)** + migrate to withSpan |
| Categorizer max_tokens | 200 | `src/cognitive/categorizer.ts:307` | unchanged (cheap classifier) |

---

## §8. Message & queue limits

| Limit | Current | Source | Target |
|---|---|---|---|
| `MEMPHIS_CHAT_MAX_MESSAGES` | 40 default | `crates/memphis-operator/src/chat.rs:33` | **10,000 default** (env-driven) |
| `MEMPHIS_MAX_PENDING_TASKS` | 1,000 default / 100,000 max | `src/infra/config/schema.ts:119` | unchanged |
| `MEMPHIS_MAX_CONCURRENT_TURNS` | optional / 1,000 max | `src/infra/config/schema.ts:246` | unchanged |
| `MEMPHIS_MAX_QUEUED_TURNS` | optional / 100,000 max | `src/infra/config/schema.ts:247` | unchanged |
| `MEMPHIS_QUEUE_WAL_MAX_BYTES` | 10 MB default / 1 GB max | `src/infra/config/schema.ts:118` | unchanged |

---

## §9. Rate limiting (untouched)

Rate limits remain as-is. They are safety nets, not productivity caps.

| Limit | Default | Max | Source |
|---|---|---|---|
| `MEMPHIS_RATE_LIMIT_GLOBAL_MAX` | 600/min | 100,000/min | `src/infra/config/schema.ts:279` |
| `MEMPHIS_RATE_LIMIT_SENSITIVE_MAX` | 60/min | 10,000/min | `src/infra/config/schema.ts:280` |

---

## §10. Env-registry status

**Location**: `src/config/env-registry.ts`
**Current accessor count**: 19
**ESLint rule**: `no-restricted-syntax` warns on raw `process.env.X` outside env-registry (commit `f78ea559`)
**Raw `process.env.X` reads remaining**: ~125 (Sprint D Phase 3 migration pending)

**Phase 1.5.2** adds **16 new accessors** (one per limit listed in §4–§7 above). Net registry count after Phase 1.5: **35** accessors.

---

## §11. Strategy: cap = sanity rail, not budget

Old caps were artificial economic limits (1MB tokens "feels expensive"; 90s timeout "should be enough"). New caps are physical sanity rails:

| New cap | Rationale |
|---|---|
| `GEN_TIMEOUT_MS` max = 86,400,000 (24h) | Runaway prevention; nothing should run >1 day per request |
| `GEN_MAX_TOKENS` max = 1,048,576 (1MB) | No provider supports more; pure runaway rail |
| `loop_max_steps` default = 1000 | Operator wants 2-week sessions; 1000 steps ≈ multiple thousand tool calls |
| `exec_timeout` default = 3,600,000 (1h) | Builds, training runs, corpus indexing legitimately take 30-60min |
| `build_timeout` default = 7,200,000 (2h) | Cold full-repo Rust builds occasionally cross 1h |

Operator can override per-task via env when needed; defaults err on the side of "Memphis can finish."

---

## §12. Final v1.8.2 outcome

After Phase 1.5 lands:
- 16 new env accessors in env-registry
- 17 hardcoded timeouts converted to env-driven
- Rust↔TS limit parity test in CI
- Schema caps relaxed to sanity rails
- `chat.rs:290` reads env, not hardcoded 2048
- Operator-facing `memphis explain limits` surfaces effective values + sources

**Verification**: `MEMPHIS_LOOP_MAX_TOOL_CALLS=200 memphis chat …` actually executes >16 tool calls (proving Rust no longer silently caps). `MEMPHIS_GEN_MAX_TOKENS=8192 memphis chat …` returns 8192-token output.

---

**Generated**: 2026-05-08 by autopilot Phase 0.5 (`automode-silly-pike`).
**Sources**: 3-agent exploration audit + manual grep verification of file:line references.
