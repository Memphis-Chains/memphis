# Plan: MemphisOS Full Roadmap — Sprint 0 through M8

> Superseded historical roadmap.
>
> This document is kept for audit/history and older sprint context, but it is no longer the canonical roadmap to `v1.0.0`.
> Use [docs/EXECUTION-PLAN.md](./EXECUTION-PLAN.md) as the canonical roadmap.
> Use the external workspace sprint board for active execution tracking.

**Date:** 2026-03-24
**Status:** Approved

---

## Context

MemphisOS is on a structured release path from v0.2.0-beta.1 to v1.0.0 GA. This plan covers **all sprints from Sprint 0 (completed) through M8 (v1.0.0 GA)**, integrating:
- The **"Truth in Docs"** sprint we just finished (Sprint 0 equivalent — docs cleanup)
- **Sprint 3** — hardening & fixes from `todo_fixes.md` ✅
- **Sprint 17-20** — zero-friction install, Telegram, auto-memory, Discord (from `MEMPHIS_DELIVERY_v1.0.0_Sprint.md`)
- **M1–M8** — the 8 milestones from `ROADMAP.md`

Current state: Sprint 0 ✅, Sprint 3 ✅, Sprint 4 ✅, Sprint 17 🔄 (planned), Sprint 18-20 📋 (planned)

---

## Sprint 0 (DONE ✅) — Truth in Docs

**Already completed:**
- Archived 22 files to `docs/archive/`
- Fixed stale Node.js 20→24, MEMORY.md embedding claim
- Wrote 5 new docs (EMBEDDING-ARCHITECTURE, VAULT-PEPPER-LIFECYCLE, CHAIN-EXPORT, TUI-OPERATOR-GUIDE, COGNITIVE-MODELS-STATUS)
- Fixed NAPI-CONTRACT-V1.md vault return types
- Updated CANONICAL-ARCHITECTURE.md Section 8 gaps
- Committed `cache.test.ts`, moved `rust-crates-architecture.md` to `docs/`

---

## Sprint 3 — Hardening & Fixes

**Goal:** Close 20 P1/P2/P3 issues before M1. Pre-condition for M1.

### Phase 1 — `.gitignore` (5 min)

```
crates/memphis-napi/data/embed-index.json
.claude/settings.local.json
```

### Phase 2 — P1 HIGH (8 issues)

| # | Issue | File | Fix |
|---|-------|------|-----|
| 5.1 | Password hashing — verify only | `src/infra/auth/operator-gate.ts` | Already uses PBKDF2. Confirm no raw SHA-256 for passwords elsewhere. |
| 5.2 | Security tests missing | `tests/security/` | New dir: chain-integrity, auth-bypass, path-traversal, fail-closed |
| 5.3 | `input!` non-null crash risk | `src/modules/orchestration/service.ts` | Replace `input!` with null-checks |
| 5.4 | Fallback provider no cooldown check | `src/modules/orchestration/service.ts` | Add cooldown check before fallback |
| 5.5 | SyncManager.writeChain() non-atomic | `src/sync/sync-manager.ts` | Atomic rename (write→`.tmp`→rename) |
| 5.6 | No sync logic tests | `tests/unit/sync.test.ts` | New: init, sync, conflict resolution |
| 5.7 | Socket leak in SyncProtocol | `src/sync/protocol.ts` | Add `socket.destroy()` in finally |
| 5.8 | constantTimeBufferCompare timing leak | `src/security/constant-time.ts` | Fix early-return on length mismatch |

### Phase 3 — P2 MEDIUM (8 issues, 6.7 closed)

| # | Issue | File |
|---|-------|------|
| 6.1 | isSoulMemoryEmpty() incomplete | `src/sync/` |
| 6.2 | writeSoulMemory non-atomic | `src/sync/` |
| 6.3 | ModelD private key random | `src/cognitive/model-d.ts` |
| 6.4 | Insight type duplicated in 3 places | `src/cognitive/types.ts` |
| 6.5 | ResilienceManager 1/3 strategies work | `src/resilience/` |
| 6.6 | HnswIndex no tests, not integrated | `src/resilience/` |
| 6.8 | use-provider-health.ts dead code | `src/tui/` |
| 6.9 | Double SQLite connection in MCP | `src/mcp/` |

### Phase 4 — P3 LOW (5 issues)

| # | Issue | File |
|---|-------|------|
| 7.1 | decision-screen.ts never rendered | `src/tui/` |
| 7.2 | execLimiter unused | search for it |
| 7.3 | Hardcoded version in dashboard HTML | `src/tui/` |
| 7.4 | Ask-session type fragmentation | `src/cognitive/` |
| 7.5 | ProviderName excludes glm/minimax/deepseek | `src/providers/` |

---

## Sprint 4 — Doctor v3 Architecture Health

**Goal:** Fix architecture issues found by Doctor v3 Tier A checks.

**Results:** 10 checks — 4 PASS, 1 FAIL, 5 WARN
**Commit:** `712ffdb`

### Phase 1 — FAIL Fix (P1)

| # | Issue | File | Fix |
|---|-------|------|-----|
| A4 | Double SQLite connection (3 instances) | `src/app/bootstrap.ts`, `src/app/container.ts` | Consolidated to single shared client passed through container |

### Phase 2 — P1/P2 Warnings

| # | Issue | File | Fix |
|---|-------|------|-----|
| A5 | SyncManager.writeChain non-atomic | `src/sync/sync-manager.ts` | Wrapped loop in `withAppendLock` + new `appendPrecomputedBlock` |
| A3 | HnswIndex not integrated | `src/resilience/fallback.ts` | Added HnswIndex as 3rd cascade strategy |
| A10 | isSoulMemoryEmpty incomplete review | `src/soul/memory.ts` | Reviewed — all meaningful fields checked (no change needed) |

### Phase 3 — P3 Warnings

| # | Issue | File | Fix |
|---|-------|------|-----|
| A7 | Hardcoded version (v5 vs v0.4.0) | `demo/index.html` | Dynamic version from package.json via fetch |
| A9 | Insight type duplication | `src/cognitive/types.ts`, `src/cognitive/model-e-types.ts` | Intentional — different evidence types for different layers (no change) |

**Verification:**
```bash
npm run typecheck && npm run lint && npm run build && npm run ops:drill-guards
```

---

## Sprint 17 — Zero-Friction Install + Bootstrap

**Goal:** User can install Memphis in 10 minutes with zero friction.

### S17-1 — Vault auto-init in bootstrap
- `npm run bootstrap` initializes vault automatically if not already initialized
- Supports `MEMPHIS_VAULT_PASSPHRASE` env var for scripted installs
- Falls back to interactive prompt or generates recovery key for first-time users
- **Files:** `scripts/bootstrap.sh`

### S17-2 — Ollama model auto-detection
- Bootstrap detects available Ollama models and auto-selects best one
- Priority: cogito > qwen > phi3 > other
- Falls back to cloud provider (MiniMax/GLM) if Ollama not available
- **Files:** `scripts/bootstrap.sh`, `package.json`

### S17-3 — Telegram one-flag wiring
- `MEMPHIS_TELEGRAM_BOT_TOKEN=xyz npm run bootstrap` wires Telegram automatically
- Sets `MEMPHIS_CHANNEL_GATEWAY_ENABLED=true` in .env
- Telegram adapter auto-starts on `npm run dev`
- **Files:** `scripts/bootstrap.sh`, `src/gateway/channels/telegram.ts`

### S17-4 — GLM provider in .env.example
- Uncommented and documented in `.env.example`
- **Files:** `.env.example`

### S17-5 — cli.vault.test.ts timeout fix
- Increase test timeout from 15s to 30s
- **Files:** `tests/cli/vault.test.ts`

### S17-6 — cli.insights.test.ts strict mode fix
- Configure signer or disable strict mode for test path
- **Files:** `tests/cli/insights.test.ts`

### S17-7 — Rust deprecation warnings cleanup
- Replace `derive_master_key_v2` with new API
- Remove unused imports
- **Files:** `crates/memphis-vault/`

### S17-8 — Wire GET /api/status + GET /dashboard
- HTTP routes for system dashboard
- Shows: chain health, memory stats, provider health, vault status, uptime
- **Files:** `src/dashboard/`, `src/infra/http/`

### S17-9 — Doctor --fix auto-repairs
- `npm run -s cli -- doctor --fix` auto-repairs all fixable issues
- **Files:** `src/infra/cli/utils/doctor-v2.ts`

---

## Sprint 18 — Telegram Gateway + Vault Keys

**Goal:** Telegram fully wired, secrets in vault not .env.

### S18-1 — Telegram gateway auto-start
- Works with one env var: `MEMPHIS_TELEGRAM_BOT_TOKEN`
- Auto-starts when `MEMPHIS_CHANNEL_GATEWAY_ENABLED=true`
- **Files:** `src/index.ts`, `scripts/bootstrap.sh`

### S18-2 — Vault-backed API keys
- MiniMax, DeepSeek, GLM keys from vault instead of plaintext .env
- KEK/DEK ring for key management
- **Files:** `src/modules/vault/`, `.env`

---

## Sprint 19 — Auto-Memory + SQLite Sessions

**Goal:** Agent remembers across sessions automatically.

### S19-1 — Auto-memory injection
- On every `/v1/chat/generate` with `userId`, auto-recall top-K relevant memories
- Stores after every exchange automatically
- **Files:** `src/modules/orchestration/service.ts`, `src/modules/memory/`

### S19-2 — SQLite session store
- Replace file-based session store with SQLite
- Migration path for existing sessions
- **Files:** `src/infra/storage/`

### S19-3 — GET /v1/sessions/:id/messages API
- Expose session history via HTTP API
- **Files:** `src/infra/http/routes/`

---

## Sprint 20 — Hardening + Channel Expansion

**Goal:** Production-hardened with multi-channel support.

### S20-1 — Telegram user allowlist
- Only approved users can chat via Telegram
- **Files:** `src/gateway/channels/telegram.ts`

### S20-2 — Rate limiting per userId
- Limit requests per user to prevent abuse
- **Files:** `src/infra/http/`

### S20-3 — Markdown formatting in Telegram
- Code blocks, message splitting for long responses
- **Files:** `src/gateway/channels/telegram.ts`

### S20-4 — Discord adapter
- Thin adapter (same pattern as Telegram)
- Auto-start with `MEMPHIS_DISCORD_BOT_TOKEN`
- **Files:** `src/gateway/channels/discord.ts` (new)

---

## M1 — v0.3.0 (Stability & Release Reliability)

**Timeline:** 2026-04-16 → 2026-05-15
**Goal:** Transition from feature-beta to predictable release reliability.

### M1.1 — Sprint 17-20 completion
All Sprint 17-20 items must be closed before M1:
- Zero-friction install works end-to-end
- Telegram wired and functional
- All tests green (including vault timeout fix)

### M1.2 — Sprint 3 completion
All P1/P2/P3 issues from above must be closed and verified:
```
npm run typecheck && npm run test:ts && npm run lint && npm run test:ops
```

### M1.2 — CI gates hardening
- Harden CI: build/test/lint/security baseline
- Close known beta regressions and flaky tests
- Reproducible install on Linux/macOS/WSL

### M1.3 — Docs finalization
- Finalize install + quickstart consistency across docs
- Release readiness checklist automation (`npm run ops:release-preflight`)

### M1 Success Criteria
- ≥98% pass rate on main branch CI over rolling 14 days
- No P0/P1 open defects at release cut
- `v0.3.0` tagged and released

---

## M2 — v0.4.0 (Security Hardening Baseline)

**Timeline:** 2026-04-16 → 2026-05-28
**Goal:** Complete pre-audit hardening, reduce high-risk attack surface.

### M2.1 — Security hardening
- **Threat-model refresh** — runtime, plugin, sync channels
- **Secret handling + key rotation** — tighten pepper lifecycle, DEK/KEK ring from `docs/KEY-ROTATION-DESIGN.md`
- **Dependency vulnerability budget** — SCA in CI, remediation SLA
- **Security regression suite** — mandatory in CI (expand `tests/security/` from M1)

### M2.2 — From ROADMAP
- Published security hardening report
- Operator guidance for key rotation and pepper management

### M2 Success Criteria
- 0 known Critical/High vulnerabilities at release
- Security test suite green in CI
- `v0.4.0` tagged

---

## M3 — v0.5.0 (Performance Optimization I)

**Timeline:** 2026-05-29 → 2026-06-30
**Goal:** Production-grade latency and memory baselines.

### M3.1 — Profiling & hotspots
- Retrieval pipeline profiling (`src/infra/embeddings/`, `src/cognitive/`)
- Embedding latency: LocalDeterministic (dim-32) vs Ollama (dim-768) benchmark

### M3.2 — Cache policy tuning
- ResilienceManager cache: TTL/LRU tuning (from 6.5 fix)
- HnswIndex integration (from 6.6 fix)
- Benchmark harness standardization

### M3 Success Criteria
- P95 query latency within SLO targets
- No performance regression >10% on core benchmark set
- `v0.5.0` tagged

---

## M4 — v0.6.0 (Performance Optimization II + Scale)

**Timeline:** 2026-07-01 → 2026-08-12
**Goal:** Scale behavior for larger repos and multi-session usage.

### M4.1 — Scale hardening
- Index/update path optimization for larger datasets
- Concurrency controls and queue handling
- Load/stress test suite with failure-mode coverage

### M4.2 — From M3/M4 tasks
- Observability metrics and tracing hooks (TUI observability-store already exists)
- Stress tests: no data-loss/corruption outcomes

### M4 Success Criteria
- Stable operation at target scale envelope
- Scaling guidance published
- `v0.6.0` tagged

---

## M5 — v0.7.0 (Enterprise Controls)

**Timeline:** 2026-08-13 → 2026-09-24
**Goal:** Enterprise-ready governance and operational controls.

### M5.1 — RBAC & policy
- Role-based access control for high-sensitivity actions
- Policy controls integration (currently: fail-closed enforcement exists)

### M5.2 — Audit & config
- Audit trail completeness + export tooling
- Config profile hardening for production
- Backward-compatible config migration tooling

### M5 Success Criteria
- Enterprise control set validated
- Audit logs meet traceability requirements
- `v0.7.0` tagged

---

## M6 — v0.8.0 (Ecosystem & Integration Maturity)

**Timeline:** 2026-09-25 → 2026-10-29
**Goal:** External integrations and ecosystem developer experience.

### M6.1 — Plugin + API
- Plugin contract stabilization + compatibility tests
- API quality: errors, docs, examples (MemphisOpenClaw integration in `docs/OPENCLAW-INTEGRATION.md`)
- Integration certification checklist

### M6.2 — MCP maturity
- Native MCP bridge (currently: simulation — `docs/PHASE6-MCP-E2E-EVIDENCE.md`)
- MCP E2E: replace simulation with native bridge
- Dual SQLite connection fix (item 6.9) pays off here

### M6 Success Criteria
- Integration test matrix green
- Developer docs complete for all public interfaces
- `v0.8.0` tagged

---

## M7 — v0.9.0 (v1 Readiness / RC Program)

**Timeline:** 2026-10-30 → 2026-12-03
**Goal:** Formal v1.0.0 readiness with RC cycles.

### M7.1 — Freeze & RC
- Freeze breaking-scope proposals
- Migration guides + compatibility docs
- RC cycle: `rc.1`, `rc.2` as needed

### M7.2 — Blockers resolved
- All release blockers from audit/performance/enterprise tracks closed
- User feedback from beta + ecosystem adopters incorporated

### M7 Success Criteria
- 0 unresolved release-critical issues
- RC telemetry indicates stable behavior
- Go/No-Go committee approves 1.0 cut
- `v0.9.0` tagged

---

## M8 — v1.0.0 (General Availability)

**Timeline:** 2026-12-04 → 2027-01-15
**Goal:** Ship GA with support commitments and operational maturity.

### M8.1 — GA release
- Publish GA release notes + support matrix
- Launch LTS branch + backport policy
- Finalize operator runbooks, SLOs, incident procedures

### M8.2 — Sign-off
- Final audit + performance signoff
- 30-day post-GA stability window

### M8 Success Criteria
- GA shipped with signed artifacts + complete docs
- LTS policy active
- `v1.0.0` tagged

---

## Full Timeline Overview

```
2026-03    Sprint 3 (Hardening) ✅
2026-03    Sprint 4 (Doctor v3) ✅
2026-03/04 Sprint 17 (Zero-Friction Install) 🔄
2026-04    Sprint 18 (Telegram + Vault Keys) 📋
2026-04/05 Sprint 19 (Auto-Memory + SQLite) 📋
2026-05    Sprint 20 (Hardening + Discord) 📋
           ──────────────────────────────
           M1 v0.3.0 (Stability)
2026-05    ──────────────────────────────
2026-06    M2 v0.4.0 (Security Hardening)
2026-07    M3 v0.5.0 (Performance I)
2026-08    ──────────────────────────────
2026-09    M4 v0.6.0 (Performance II + Scale)
2026-10    M5 v0.7.0 (Enterprise Controls)
2026-11    ──────────────────────────────
2026-12    M6 v0.8.0 (Ecosystem)
2027-01    M7 v0.9.0 (v1 Readiness/RC)
2027-02    M8 v1.0.0 (GA)
```

---

## Cross-Cutting Themes

| Theme | Sprint 3 | Sprint 17-20 | M1 | M2 | M3–M4 | M5–M6 | M7–M8 |
|-------|----------|----------|----|----|----|----|----|
| Security tests | ✅ P1 | | Expand | Full CI | Monitor | Audit-ready | Final |
| Perf benchmarks | | | | | ✅ M3/M4 | | |
| Docs accuracy | ✅ Truth in Docs | ✅ Bootstrap | Finalize | Security guidance | Performance | Enterprise | GA docs |
| Hardening | ✅ 20 fixes | ✅ S17-7 | CI gates | Threat model | Scale | | |
| Onboarding/UX | | ✅ S17,S18,S19 | | | | | |
| Integration | | ✅ S20 Discord | | | | MCP native | RC freeze |

---

## Verification Gates

| Milestone | Gate |
|-----------|------|
| Sprint 3 | `npm run typecheck && npm run test:ts && npm run lint` |
| M1 | `npm run test:ops && npm run build` + 98% CI pass rate |
| M2 | 0 Critical/High vulns + security suite green |
| M3 | P95 latency within SLO + benchmark regression <10% |
| M4 | Scale envelope stable + stress tests pass |
| M5 | Enterprise controls validated + audit logs complete |
| M6 | Integration matrix green + MCP native bridge |
| M7 | 0 release blockers + RC stable |
| M8 | GA shipped + LTS active |
