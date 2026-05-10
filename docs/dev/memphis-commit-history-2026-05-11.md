# Memphis Commit History Map — 2026-05-11

**Generated:** parallel Explore agent scan, 2026-05-11.
**Scope:** Memphis v1.8.0 OSS, ostatnie 12 tygodni + 6 miesięcy.
**Audience:** human operator — research base dla planowania kolejnych sprintów.

---

## 1. Velocity — tygodniowe commity (ostatnie 12 tygodni)

```
2026-W10:  22 commits   (early peak, before storm)
2026-W11: 227 commits   ⭐ PEAK WEEK — mass Phase 5-8 pack merge blitz
2026-W12:  60 commits   (postmerge stabilization)
2026-W13: 183 commits   (rebuild, closure Z.x sprint)
2026-W14:  66 commits   (cooldown)
2026-W15:  42 commits   (minimal — vacation/sprint boundary?)
2026-W16:  65 commits   (recovery)
2026-W17: 122 commits   (Phase 4 / closure burst)
2026-W18:  97 commits   (sustain)
2026-W19: 140 commits   (final Q2 push: autonomy unblocking)
2026-W20:   2 commits   (this week, partial)
```

**Trend:** Bimodalny pattern — 2 piki (W11: 227, W13: 183, W19: 140) rozdzielone cooling-off (W14-W15). Mediana: ~100 commitów/tydzień. Brak stagnacji — konsystentna aktywność nawet w slowdowns.

---

## 2. Top files touched (most-edited, ostatnie 6 miesięcy)

| Plik | Edycji | Kategoria |
|------|--------|-----------|
| package.json | 122 | Root deps mgmt |
| README.md | 89 | Docs |
| src/app/bootstrap.ts | 68 | Core TS infra |
| src/infra/http/server.ts | 63 | API server |
| src/infra/config/schema.ts | 51 | Config core |
| src/infra/cli/index.ts | 48 | CLI router |
| src/infra/cli/handlers/system.handler.ts | 47 | CLI system cmds |
| src/infra/cli/utils/doctor-v2.ts | 46 | Health checker |
| src/mcp/server.ts | 43 | MCP transport |
| src/gateway/system-prompt.ts | 40 | Agent system prompt |

**Hot zones:** Bootstrap, HTTP server, CLI handlers (doctor, system), MCP glue. Config/schema stabilny. Brak martwych plików w top 20 — wszystkie aktywne ostatnie 4 tygodnie.

---

## 3. Sprint markers & phases (major closures, 6 miesięcy)

Top sprints po liczbie commitów:
- **Phase 1**: 76 commits (longest closure, ~2 miesiące)
- **Phase 3**: 61 commits (major feature batch)
- **Phase 2**: 43 commits
- **Sprint E**: 27 commits (parallel)
- **Sprint 1**: 26 commits
- **Phase 4**: 24 commits
- **Sprint 0**: 18 commits (bootstrap)
- **Sprint H**: 17 commits

Closure series (**Z.0–Z.7** stability sprints):
- closure Z.5: 3 commits (recent)
- closure Z.2, Z.1: 1–2 commits each
- hotfix(codex-round-1, -2): 1 commit each (May 10 incident bundles)

**Pattern:** Phases (feature work) > Sprints (parallel tracks) > Closure (hardening). Phase 1 dominacja → pivot do Z-series stability.

---

## 4. Recent significant work — ostatnie 2 tygodnie (top 40 commits)

**Dominant themes:**
- **fixes: 105 commits** — overflow extraction, whitespace filtering, CLI routing, env config
- **features: 58 commits** — voice systemd survival, Anthropic Opus 4.6 default, anti-confab phase 2, cache 128k ephemeral, embed bulk flush
- **docs: 20 commits** — DAILY-ASSISTANT-SETUP.md, agent operational patterns (2026-05-10), dev runbooks
- **refactor: 11 commits**
- **test: 9 commits**

**Key commits (ostatnie 7 dni):**
- `e82d0154` fix(operator) — drop None/None tokens from overflow render (MiniMax 2026-05-11)
- `029a0d95` minimax-overflow extraction (unblocking session 2026-05-10)
- `4696f573` docs — agent operational patterns 2026-05-10 (10 patterns + 9 soul learnings)
- `7f85f184` fix(install) — python3-venv + tesseract-ocr prereqs
- `96338c66` feat(voice) — systemd user units (reboot survival)
- `9786f9c0` feat(anthropic) — claude-opus-4-6 default + fallback chain
- `06ad7463` feat(anthropic) — ephemeral prompt cache 128k
- `8c134a48` fix(embed) — bulk upsert flush + NDJSON v2 (I/O amplification kill 68 GB → 50 MB)

**Momentum:** Stabilizacja operator daily-use (doctor, config roots), voice resilience, cache optimization, autonomy unblocking.

---

## 5. Crate vs TS split (6 miesięcy, 7507 total file touches)

| Area | Touches | % |
|------|---------|---|
| `src/` (TypeScript) | 2933 | 39.1% |
| config/root | 1505 | 20.0% |
| `tests/` | 1514 | 20.2% |
| `docs/` | 1175 | 15.6% |
| `crates/` (Rust) | 380 | 5.1% |

**Rust distribution (380 touches):**
- memphis-tui: 97 (25.5%) — UI/terminal shell
- memphis-operator: 79 (20.8%) — core orchestration
- memphis-napi: 60 (15.8%) — N-API bindings
- memphis-vault: 57 (15.0%) — secret vault
- memphis-core: 36 (9.5%) — baseline
- memphis-embed: 35 (9.2%) — embeddings

**Charakterystyka:** TS dominacja (59.3% w src + tests), ale Rust TUI + operator backbone stabilny (46.3% Rust budget). Docs allocation (15.6%) signals mature project.

---

## 6. Martwe pliki — heavy activity before, silence ostatnie 4 tygodnie

Pliki edytowane frequently ale bez ruchu ostatnie 4 tygodnie (candidates dla dead code / refactored out):
- `.github/workflows/*.yml` — CI infra (frozen, mature)
- `ADR-*.md`, `ARCHITECTURE_V0.md` — past design decisions (archived)
- `CHANGELOG_SPRINT*.md` — legacy (superseded by closure Z-series)
- `.env`, `.prettierrc`, `.importsortrc` — config boilerplate (no active change)

**Pattern:** Archeolog migration. Stare ADRs, SPRINT changelog backups nie ruszane. Working docs (ONBOARDING, INSTALL, RUNBOOK) fresh (ostatnie 2 tygodnie). **Brak dead code w application layer** — wszystkie `src/` files touched actively.

---

## 7. High-level evolution vector

**Memphis 6 miesięcy: Autonomy hardening + Agent reliability.**

Dominacja Phase 1-4 (76 + 43 + 61 + 24 = 204 commits, 40% 12-week budget) to feature expansion (voice, vault, embeddings, MCP glue). Pivot do closure Z-series (104 commits) = obsesja stability, CI/CD hardening, doctor health-check completeness.

Ostatnie 2 tygodnie: **autonomy unblocking session (2026-05-10 tag widoczny w 6+ commits)** — cache optimization, overflow mitigation, env config anchoring. Voice reboot-survival + Opus 4.6 default wskazują **production readiness narrative** — nie eksperyment, lecz operator daily-use tool.

---

## 8. Cytowane konkretnie (cross-ref)

- Peak week SHA: `db67d9d7`, `772547d0` (Phase 5-8 pack mass merge)
- Autonomy unblocking 2026-05-10:
  - `06ad7463` (cache 128k)
  - `8c134a48` (embed flush bulk)
  - `257d2fb4` (doctor PROJECT_ROOT install-root)
  - `3b0a12d5` + `c06238dc` (cwd-bug family — env-file + sandbox boundary)
  - `61a7d4f1` (mode-dispatch drop 32k cap)
  - `9786f9c0` (Opus 4.6 default + fallback)
  - `810f0ab6` (anthropic whitespace text-block guard)
- Live docs: `053c514b` (DAILY-ASSISTANT-SETUP.md), `6c335c95` (ONBOARDING + INSTALL + RUNBOOK)
- Closure Z.7 marker: `a973261e` (chore, W19)

---

**Last updated:** 2026-05-11.
**Next refresh:** weekly, replace this doc lub append delta section.
