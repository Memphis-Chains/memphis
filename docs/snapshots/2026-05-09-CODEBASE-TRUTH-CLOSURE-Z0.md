# CODEBASE TRUTH — Closure Sprint Z.0 Snapshot

**Date:** 2026-05-09
**HEAD `main`:** `4fb5145f` (per audit; my session branch `feat/vault-pepper-rotate-generate` at `bb0cc238`)
**Sprint:** Z (closure for "stable for operator daily use", supersedes post-Zawoja v1.8.1→v1.9.2)
**Author:** Claude Opus 4.7 (autopilot session, supervised by operator Marcin "Wodzu" Kukla)

> **Purpose.** Read-only audit before any code change in the closure sprint. Establishes the baseline so the 7 phases (Z.0–Z.7) can verify they actually closed the gaps they claimed to close. Per `feedback_truth_before_refactor` memory.

---

## 1. Open issues — triage table (27 → 3 target)

| # | Title (truncated) | Phase | Action |
|---|---|---|---|
| #44 | MAXIMUM-TOOLKIT: Research — 500+ tools across 12 categories | Z.6 | **defer** (toolkit-roadmap, post-v1.x) |
| #47 | Phase 2: Cloud + IaC — AWS/GCP/Azure/Terraform/Ansible/K8s | Z.6 | **defer** (toolkit-roadmap) |
| #48 | Phase 3: Network + Security — nmap/tcpdump/Vault/Prometheus | Z.6 | **defer** (toolkit-roadmap) |
| #49 | Phase 4: Offensive Security — pentest/credentials/privesc | Z.6 | **defer** (toolkit-roadmap) |
| #50 | Phase 5: Skill Engine — skill DSL/AI composer | Z.6 | **defer** (toolkit-roadmap) |
| #56 | [MED] Skills system underutilized — no skill marketplace | Z.6 | **investigate-then-close** (no real bug; UX gap, defer) |
| #57 | [MED] No automatic learning extraction or self-reflection loop | Z.6 | **investigate-then-close** (per `project_post_v19_roadmap` memory; v2.0 scope) |
| #62 | [MED] CLI has no centralized command registry with lazy loading | Z.6 | **investigate-then-close** (registry exists at `src/infra/cli/registry.ts`; this issue stale) |
| #113 | [ENHANCEMENT] GPG-sign release artifacts in CI release workflow | Z.6 | **defer** (release-process, not stability blocker) |
| #114 | [ENHANCEMENT] Adopt OTel withSpan wrappers at turn/provider/tool/vault | Z.6 | **defer** (instrumentation already partial via `withSpan`; non-blocking) |
| #115 | [ENHANCEMENT] Snapshot testing + coverage thresholds | Z.6 | **defer** (test-infrastructure-roadmap) |
| #116 | [ENHANCEMENT] Conventional commits + automated changelog | Z.6 | **defer** (release-process) |
| #117 | [CHORE] Stale TODO in soul/memory.ts: vault-encrypt + archive to vault | Z.6 | **investigate-then-close** (verify TODO state at file, close if completed/superseded) |
| #147 | roadmap: Memphis architectural plan — Private → GUI → Agora | Z.6 | **defer** (top-level roadmap, post-v1.x) |
| #148 | phase P: Private tier hardening | Z.6 | **defer** (Agora-roadmap) |
| #150 | phase B: Blueprint Config System (Zod → GUI form + TS validator) | Z.6 | **defer** (Agora-roadmap) |
| #151 | phase T: Trust chains | Z.6 | **defer** (Agora-roadmap) |
| #152 | phase G: Tauri GUI skeleton | Z.6 | **defer** (Agora-roadmap, post-v1.x per memory) |
| #153 | phase 0: Agora design doc | Z.6 | **defer** (Agora-roadmap) |
| #154 | phase 1: Agora L1 Attestations + trust-graph BFS | Z.6 | **defer** (Agora-roadmap) |
| #155 | phase 2: Agora L3 Reviews + weighted reputation | Z.6 | **defer** (Agora-roadmap) |
| #156 | phase 3: Agora L2 Stake + ML contracts | Z.6 | **defer** (Agora-roadmap) |
| #157 | phase 4: Agora L4 Discovery (DHT / gossip) | Z.6 | **defer** (Agora-roadmap) |
| #158 | phase 5: Agora Marketplace UX in Tauri GUI | Z.6 | **defer** (Agora-roadmap) |
| #160 | phase 3-spike: memphis-ml viability TIMEBOX | Z.6 | **defer** (Agora-roadmap) |
| #161 | phase 4.5: Agora adversarial simulation | Z.6 | **defer** (Agora-roadmap) |
| #407 | macOS: cli-router.integration.test.ts | Z.3.1 | **fix** (PR-Z3.1 closes) |

**Summary:**
- 21 issues → defer-to-v2.0 (template A)
- 4 issues → investigate-then-close (template C: #56, #57, #62, #117)
- 1 issue → fix-then-close (template B: #407)
- 1 active follow-up issue from Z.1.1 (file new for #270 Layer 2)

**Final state target:** 0–2 open issues (any new operator-driven bugs).

---

## 2. CI failure tree (last 10 runs on main)

| Workflow | Last run | Conclusion |
|---|---|---|
| Telegram smoke test | 2026-05-09T08:10 | ✅ success |
| offline-acceptance | 2026-05-09T06:07 | ❌ **failure** |
| nightly-crystal | 2026-05-09T05:29 | ❌ **failure** |
| Telegram smoke test | 2026-05-09T03:55 | ✅ success |
| ci | 2026-05-08T22:04 | ❌ failure |
| ci | 2026-05-08T21:09 | ✅ success |
| ci | 2026-05-08T21:02 | ❌ failure |
| ci | 2026-05-08T21:00 | ❌ failure |
| ci | 2026-05-08T20:58 | ❌ failure |
| ci | 2026-05-08T20:54 | ✅ success |

**Active failures:**
1. `offline-acceptance` 2026-05-09T06:07 — **Z.1.2 target**
2. `nightly-crystal` 2026-05-09T05:29 — **Z.1.2 target**
3. `ci` (quality-gate testTs) 2026-05-08T22:04 — **Z.1.1 target** (incident-bundle test 1/2971 fail per pre-Z.0 audit)

**Telegram smoke ✅** — last 2 runs green; no Telegram regressions.

---

## 3. Doctor breakdown (1 fail + 14 warn, ok=null)

### Failure (1) — Z.2.1 target

| ID | Title | Detail |
|---|---|---|
| `ta12-voice-stack` | Voice stack readiness | route=local, STT unreachable (fetch failed), TTS unreachable (fetch failed) |

**Action:** PR-Z2.1 downgrades fail→warn unless `MEMPHIS_VOICE_ROUTE_REQUIRED=local` set explicitly.

### Warns (14) — Z.2.2 target (bundled clear)

| ID | Detail | Z.2.2 action |
|---|---|---|
| `t2-offline-runtime-mode` | active=remote, supported=local-fallback, ollama-local, ollamaReachable=true | informational, accept (active=remote is intentional) |
| `t3-embed-search-latency` | 1289.603ms (target <10ms, backend=ollama/nomic-embed-text) | accept (target <10ms is unrealistic for ollama; raise threshold to 2000ms or document) |
| `t3-memory-rss` | 180MB RSS | informational, accept (well under 500MB target) |
| `t4-2fa` | recovery Q&A not configured | operator action: `memphis vault init` already configured per `vault-state.json` 2fa flag; check probe vs reality |
| `t4-pepper-strength` | weak (25 chars) | **operator action**: post-#549-merge run `memphis vault pepper-rotate --confirm --generate` |
| `t4-alert-transport-config` | no external alert transport | accept (no PagerDuty in operator's setup; document) |
| `t4-chat-surface-hardening` | [full autonomy] telegram: operator override enabled | accept (full-autonomy mode is operator's chosen state) |
| `t5-orphans` | 6 orphan(s): `MEMPHIS_PROMPT_ARCHITECTURE.md`, `cron-scripts`, `leads.json`, `memphis.db`, `memphis.pid` | **investigate** — `memphis.pid` is process-lock (expected when daemon running); reclaim others or whitelist |
| `t5-demo-readiness` | NOT ARMED — run `memphis demo arm` | Z.5.1 target |
| `t6-external-plugin` | not installed | accept (optional; document) |
| `t6-mcp-server` | unreachable on :3001 (6ms) | mark opt-in via `MEMPHIS_MCP_REQUIRED` |
| `t6-multi-agent-sync` | not configured | accept (optional; document) |
| `t6-cron-tasks` | 1 failing task: `task-1777576880613` | **investigate-then-cancel** — examine logs at `/home/memphis/.memphis/config/scheduler/logs/<taskId>` |
| `ta13-kartograf` | no checkpoints installed | accept (optional; documented warn per doctor-v2.ts:2200) |

**Z.2.2 success criteria:** doctor reports `ok: true` (≥1 fail-cleared + at least 6 warns documented/downgraded; ≤8 remaining warns acceptable).

---

## 4. Workspace state (untracked + modified)

**Modified tracked:** none (all session work shipped via PR #549 commits).

**Untracked:**
- `docs/snapshots/` (1 file: `2026-05-09-memphis-caps-user-bot-snapshot.md` from earlier this session, ⚠ SYNTHETIC banner applied)

**Already-deferred (per audit, not visible in current `git status`):**
- `crons/simple-reminder.sh` — was untracked at audit time; now appears resolved or moved (re-verify in Z.3.2)
- `docs/zawoja-2026-przemowienie.md` — was untracked at audit time; same

**Z.3.2 action:** `git add` the snapshot by name + verify the other 2 files' status.

---

## 5. PR #549 status (Z.1.3 target)

| Field | Value |
|---|---|
| state | OPEN |
| mergeable | MERGEABLE |
| quality-gate | ✅ SUCCESS |
| cross-arch | SKIPPED (not blocking) |
| enable-automerge | SKIPPED |
| Branch | `feat/vault-pepper-rotate-generate` @ `bb0cc238` |

**Action:** Per Z.1.3, merge after Z.1.1 + Z.1.2 land. PR is ready.

---

## 6. Memory state (project / feedback memories that drive this sprint)

Active invariants engaged:
- `feedback_codex_bundled_hotfix` — Z.1.2, Z.2.2, Z.4.1
- `feedback_inline_p_skip_pattern` — Z.1.1
- `feedback_install_root_anchoring` — Z.3.1
- `feedback_local_artifacts_never_stage` — Z.3.2
- `feedback_truth_before_refactor` — this Z.0 doc
- `feedback_observable_not_nanny` — Z.2.2 (warns, not silent walls)
- `feedback_demo_readiness_rules` — Z.5
- `feedback_force_push_rules` — global constraint
- `feedback_cross_layer_coverage` — every PR
- `feedback_napi_rebuild_after_rust_changes` — Z.3.3 if Rust touched
- `feedback_truth_model_silent_catch` — error handling
- `feedback_full_autonomy_mandate` — operator selected aggressive autopilot

---

## 7. Verification gate (closure declared when ALL true)

- [ ] CI on `main` green for 3 consecutive runs
- [ ] `memphis doctor --json | jq '.summary.ok'` → `true`
- [ ] `memphis demo arm && memphis demo rehearse && memphis demo plan-b record` exit 0
- [ ] `memphis vault list` works (post #549 + operator pepper-rotate)
- [ ] Daemon 24h continuous uptime (Z.7)
- [ ] Worker count = 1 stable
- [ ] Telegram smoke green at h0, h12, h24
- [ ] ≤3 open issues (truly active bugs only)
- [ ] `ONBOARDING.md` exists + redirects work
- [ ] Memory `project_closure_2026-05-09.md` records final state
- [ ] Operator confirms: "Solidnie. Stable for daily use."

---

## 8. Risks captured at Z.0 (carried into phase planning)

1. **#270 SEGV residual** — only the revived test gates; production code path could still race. Z.7 24h proof catches regressions.
2. **`memphis.pid` orphan warn** — expected when daemon running; probe may be miscounting. Z.2.2 to verify.
3. **`task-1777576880613` cron failure** — unknown task; logs investigation required before cancel.
4. **macOS test (Z.3.1)** — cannot smoke-test from Linux. Operator manual smoke required before closure declared.
5. **Demo arm refinement** — `demo.ts` exists at 648 lines; refinement only, but probes may need real fixes against current state.
6. **Issue bulk-close** — risks closing live bugs. Template C (investigate-then-close) forces explicit findings per issue.

---

*This snapshot is point-in-time. Subsequent phases (Z.1–Z.7) will commit deltas referencing this baseline.*
