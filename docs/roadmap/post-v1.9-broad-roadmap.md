# Post-v1.9 broad roadmap — Q3 2026 direction

**Captured:** 2026-05-08, operator dictation (Wodzu / Marcin Kukla)
**Status:** SCOPE — concrete plan to be written down after current sprint PRs (#521 / #522 / #523) land and operator confirms readiness.

This document is the operator-given list of directions Memphis should head in once the immediate post-Zawoja recovery work (v1.9.x sprint) is fully closed. It is not a commitment timeline — it is the input to a sit-down "what's next, in what order" discussion.

---

## Six items operator named

> "pracujemy po twoich naprawach, nawet tych co wynajdziesz nowe nad nastepujacymi rzeczami"

1. **OAuth Anthropic dla Memphis na claude.ai Max plan**
   Currently broken — operator gets "error logging in" trying to authenticate. Without OAuth, the Anthropic provider falls back to plaintext API key (placeholder `sk-test`). Memphis is left running on MiniMax + Ollama. Fixing OAuth re-opens a high-quality provider for daily use and is gated by Anthropic's claude.ai Max-plan flow.

2. **STT → Memphis → TTS, fully local**
   Whisper for input + local TTS for output, no cloud round-trip. Existing surfaces: Memphis already has audio ingest via `memphis_media_ingest`, and `whisper-server` runs on :9000 in some configs. Known issues per soul memory: tiny model is too weak for Polish (need base/small), and OGG→WAV preflight via `ffmpeg` is required. TTS side is open scope.

3. **Video / picture local LLM via Telegram**
   Workflow: Telegram media → download local → analyze via local LLM (Ollama vision: moondream / llava / granite3.2-vision) → Memphis responds in-channel. Partial scaffolding from Sprint B3 already lives in `memphis_media_ingest`; PR #523 just registered it as an MCP tool. Next pieces: Telegram bot file-handler glue, queue/dispatch, response rendering.

4. **Offline mode**
   Working Ollama? Or "dump + kartograf" connector? Open-question scoping. The current architecture already falls back to Ollama when other providers are unreachable, so this item is partly about *defining what "offline" means in Memphis terms* — clear failure modes when net is gone, no silent partial degradation, kartograf data-pack as a pre-cached knowledge surface.

5. **Matrix Agora + kartograf_special_llm marketplace**
   Two pieces:
   - **Agora** — Memphis-to-Memphis communication channel over Matrix federation. Lets multiple Memphis instances interact (e.g., Wodzu's instance asking Szczepan's instance for a reading from his side). Identity, trust, message envelopes all need designing.
   - **Proof-of-stake / proof-of-work "legality coin"** exchange — peer-to-peer economic primitive layered on top of Agora. Funds inter-instance work or trust assertions. Substantial sub-RFC; defer concrete design until Agora has even one bilateral test deployment.

6. **memphis-v5.pl/agora + /plac as /marketplace**
   Public-facing surfaces on the marketing/website domain. Lighter-weight to ship than Agora itself — initially may be a static landing page describing what Agora is + a waitlist; later wires up to live federation once it exists.

---

## Suggested ordering — for discussion

### Tier 1 — Operational unblockers (next 2–4 weeks)

| # | Item | Why first |
|---|---|---|
| 1 | **OAuth Anthropic** | Fixes daily friction NOW. Direct impact every single Memphis session. Bounded scope (one provider adapter + token refresh path). |
| 2 | **STT / TTS local loop** | Voice-first interaction is operator-stated working preference. Whisper has known fixable issues; TTS adapter is small surface. Compounds with item 3. |

### Tier 2 — Capability extension (4–8 weeks)

| # | Item | Why next |
|---|---|---|
| 3 | **Video / picture pipeline via Telegram** | Sprint B3 work means scaffolding exists; this is gluing rather than greenfield. Operator uses Telegram daily for receiving content. |
| 4 | **Offline mode hardening** | Probably "best Ollama config + clear failure-mode messaging when net is gone". Investigate kartograf connector as a separate sub-question. |

### Tier 3 — Federation + marketplace (months)

| # | Item | Why later |
|---|---|---|
| 5 | **Matrix Agora memphis-to-memphis** | Substantial networking + identity story. Needs at least two cooperating instances to even test. Coupled with operator's "Synjar" / multi-agent strategy. |
| 5b | **Proof-of-stake legality coin** | Separate sub-RFC. Don't start until Agora has real bilateral comms. |
| 6 | **memphis-v5.pl/agora + /plac surfaces** | Website / marketing layer. Can ship a landing page in parallel with Tier 1 work. Full marketplace integration waits on (5). |

The above ordering is a *recommendation*, not a decision. Operator may want different priority based on:

- Hotel Jawor demo follow-up needs (next demo date drives what's "demo-ready")
- Grant application timelines (some items give better narrative for funding asks)
- Income-stream priorities — the "10 strumieni dochodu" thread for Beskid Żywiecki may bias toward (3) Telegram pipeline if commercial messaging is in scope

---

## Live bugs surfaced in same session (worth tickets, NOT roadmap)

These came up in the TUI + Telegram log alongside the roadmap dictation. Concrete and bounded — could be picked up earlier as one-off PRs:

- `memphis_soul_write` returns `memory: null` instead of confirmation envelope after a successful write — handler returns wrong shape
- `additions is not iterable` — soul write field validation rejects valid input shape
- Journal chain hash mismatch — integrity drift; Memphis offered `memphis_repair` automatically (good UX)
- Status bar shows `ctx:32k` for MiniMax M2.7 — model actually supports >100k; needs context-window-by-model lookup, not hardcoded 32k
- After `/clear` during a long MiniMax session, runtime continued normally — confirms PR #521's heuristic narrowing was the right call (real overflows still parse correctly; `Some(N)/None` false positives gone)

---

## Cross-references

- Memory: `project_post_zawoja_autopilot_2026-05-08.md` — current sprint context (PRs #499–#520)
- Memory: `project_post_v19_roadmap_2026-05-08.md` — verbatim ask + suggested ordering (this doc is the discussion output)
- Memory: `feedback_demo_readiness_rules.md` — every new capability needs Plan B + rehearsal
- Memory: `project_2fold_strategy.md` — Tier-1 leans LEFT (runtime), Tier-3 leans RIGHT (platform)

---

## Next step

Once PRs #521 / #522 / #523 are merged and current sprint is closed:

1. **Operator + Memphis** sit down with this doc.
2. Confirm or revise the Tier 1/2/3 ordering.
3. Pick the first concrete item, write a phase-by-phase plan (matching the autopilot plan format from `.claude/plans/automode-silly-pike.md`).
4. Estimate scope honestly — the autopilot showed that "ma byc solidnie" + cross-layer grid + cost-unconstrained means each item is bigger than it looks.

Don't start any of (1)–(6) before that conversation. The roadmap is dictated; the *plan* needs operator agreement on ordering, scope, and stop conditions per item.
