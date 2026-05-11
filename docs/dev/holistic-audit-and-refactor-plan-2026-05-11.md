# Holistic Audit + Refactor Plan — 2026-05-11

**Generated:** 2026-05-11 by Claude Code session.
**Scope:** 128 commits over last 7 days, 41 MCP tools, 4 LLM providers, multi-surface bot. Operator request: "May our agent working on every level."

---

## 1. Recent state — 128 commits 2026-05-04 → 2026-05-11

**Themes shipped:**
- **Autonomy unblocking** (8 phases): embed bulk + NDJSON v2, Anthropic caching + 128k tokens, anti-confab Phase 2 (warn-append default), doctor PROJECT_ROOT walk, CLI handlers anchored on install root (cwd-bug family closure), scheduler --ff-only, mode-dispatch token cap, Anthropic Opus 4.6 default + 4.7 fallback chain
- **Voice stack** (Piper TTS + Whisper STT): systemd reboot survival, install prereqs (python3-venv + tesseract-ocr-pol)
- **Documentation reckon**: DAILY-ASSISTANT-SETUP.md (16K, operator-facing), agent-operational-patterns-2026-05-10.md (anti-confab heuristics), memphis-architecture-map-2026-05-11.md, memphis-self-map-2026-05-11.md (bot consumption), memphis-commit-history-2026-05-11.md
- **TUI stability**: 110% CPU → 55% (poll interval 50→100/250→500ms), Anthropic whitespace text-block guard (400 fix), MiniMax overflow render fix
- **Provider cascade**: fallbackProvider=ollama (was local-fallback stub), per-model max_tokens clamp
- **Training stack** (today): Python 3.11 venv + torch 2.3.1+cu118 + transformers 4.43.4 + peft + accelerate, Kartograf v4 corpus (5168 train + 573 eval + 5133 pairs), env-driven DeBERTa-v3-large override, scheduled overnight training 23:00 CEST

**Today's vault incident** (recovery story documented in `docs/roadmap/2026-05-11-post-autonomy-todo-and-gap.md`): vault re-init z fresh passphrase + Q&A. Operator passphrase hash matches `mE/\/\phi$`.

---

## 2. Capability matrix — agent on every level

| Surface | Text | Voice (STT/TTS) | Image (Vision/OCR) | Self-modify | Tier-3 |
|---------|------|-----------------|---------------------|-------------|--------|
| **Telegram** | ✅ wired | ✅ `bot.on('message:voice')` :751, `/voice` cmd :716 + sendVoice :996; quota MEMPHIS_TTS_DAILY_CHAT_LIMIT | ✅ `bot.on('message:photo')` :834, Ollama moondream + Tesseract OCR | ✅ tier-3 commands per surface | ✅ allowed |
| **TUI** | ✅ wired | ❌ no native record shortcut | ❌ no native paste-image shortcut | ✅ tier-3 commands | ✅ allowed |
| **HTTP** | ✅ wired | ❌ not exposed | ❌ not exposed | ✅ via /v1/ops/* | ✅ allowed |
| **MCP** | ✅ 41 tools | ❌ no audio tool | ✅ `memphis_media_ingest` (gateway media pipeline) | ✅ `memphis_self_modify` | ✅ tier-2 default, escalate via env |
| **CLI** | ✅ wired | ❌ no voice path | ❌ no image path | ✅ direct edit | ✅ allowed |

**Provider coverage:**
- 4 healthy: local-fallback, ollama (qwen2.5:0.5b active), anthropic (claude-opus-4-6 + fallback 4-7), minimax (M2.7)
- 41 MCP tools exposed: introspection (chain_query/recall/health/self_describe/...), action (exec/cron/git/send/restart/...), search (grep/glob/code_read/web_fetch/web_search), codemod (self_modify), media (media_ingest), audit (audit-search)

**Memory infrastructure:**
- 9 append-only chains (~6976 blocks, ~6.5k embeddings indexed)
- SQLite `memphis.db` 36 MB (sessions, FTS5 exact search 3263 entries, generation events, tool call approvals)
- Vault (AES-256, pepper-wrapped master key, PBKDF2-HMAC-SHA256 600k iter operator passphrase)
- Embed index NDJSON v2 (Phase 1 fix landed)
- Embedding model: nomic-embed-text via Ollama

---

## 3. Gap analysis — what's missing for "agent every level"

### P0 — production blockers (none ATM)

Daemon healthy, providers healthy, vault clean. Bot replies. Telegram online.

### P1 — capability gaps (refactor candidates)

#### A. **TUI lacks voice + image input** (asymmetry vs Telegram)
- Telegram has voice + photo bidirectional. TUI only text.
- Operator working in TUI cockpit can't: dictate via mic, drop image for vision analysis.
- **Refactor:** add `/voice record` (TUI captures mic via ffmpeg → Whisper STT → text → submit as turn), `/paste image <path>` (TUI takes path → memphis_media_ingest → vision result included in next turn context).
- **Files:** `crates/memphis-tui/src/app.rs` (command parser + UI hooks), `src/infra/tui-host/commands.ts` (new commands: `media.record_voice`, `media.attach_image`).
- **Risk:** medium. ffmpeg mic capture cross-platform (Linux/Mac/Win) needs careful path. Image paste from clipboard needs OS-specific clipboard reader.

#### B. **Embed reindex 37 blocks skipped** ("text too large: 8970 bytes exceeds max 4096")
- Insight blocks > 4 KB don't index → semantic recall blind to them.
- Affects: `insights/` chain (Model B output: aggregate insights have multi-pattern text → easily >4KB).
- **Refactor:** sliding window chunker for embed pipeline. Split long content into 3KB overlapping chunks before embed. Each chunk gets `parent_block_index` field. Recall surfaces parent block, not chunks.
- **Files:** `src/infra/memory/embed-reindex.ts` (chunker), `crates/memphis-embed/src/pipeline.rs` (accept multi-chunk per block), `memphis_recall` MCP tool (deduplicate by parent_block_index).
- **Risk:** medium. Chunking strategy affects retrieval quality. Need benchmark.

#### C. **Tier-3 sessions in-memory only** (operator's NCBR Impakt II request)
- Daemon restart wipes all tier-3 sessions. Operator re-elevates every restart.
- Currently 3h wall-clock TTL, no sliding refresh.
- **Refactor:** persist sessions to `~/.memphis/state/tier3-sessions.json` encrypted via vault master key. Load on startup, drop expired. Optional sliding TTL (env flag `MEMPHIS_TIER3_SLIDING=1` refreshes on tool-call activity).
- **Files:** new `src/security/tier3-session-persistence.ts`, modify `src/security/tier3-session.ts` (hook save on grant/revoke/expire, load on module init).
- **Risk:** low. Tier3Session shape is metadata only (no passphrase). Encryption at rest defense-in-depth.

#### D. **Soul memory schema rigid** (operator hit this Apr-May)
- `soul_write` schema accepts: `name`, `languages`, `preferences`, `expertise`, `integrations` (arrays of strings).
- Rejects: `nickname`, `location`, `identity` (object), `activeWork` (string vs array).
- Operator forced to prefix-encode (`preferences: ["nickname:Wodzu", "location:Zawoja"]`).
- **Refactor:** extend schema with nullable optional fields. Add nested `identity` object. Add `activeWork: string[]` distinct from preferences. Soul memory becomes richer for cognitive prelude.
- **Files:** `src/soul/manifest.ts` schema + MCP `soul.write` tool args.
- **Risk:** low. Backward-compat by keeping existing fields. Add new optional ones.

#### E. **memphis_self_modify scoped to TS only** (not Rust crates)
- Self-modify works for `src/**/*.ts` but Rust crate edits (`crates/memphis-*/src/**/*.rs`) require operator manual rebuild + restart.
- Limits autonomous evolution to TS surface — Rust core (memory chain, vault, NAPI bridge, TUI) frozen.
- **Refactor:** extend `memphis_self_modify` to accept `--rust-crate <name>` flag. On commit, trigger `cargo build -p <crate>` + NAPI rebuild + daemon restart (graceful). Test gate runs `cargo test -p <crate>` before commit.
- **Files:** `src/mcp/tools/self-modify.ts` (Rust path), `src/infra/test-gate.ts` (cargo test), `tools/skills/memphis-rebuild-rust` (existing skill, hook it).
- **Risk:** **HIGH**. Rust crate edits affect vault integrity, chain encoding, memory layout. Strict test coverage required. Operator should explicitly authorize Rust self-modify (env flag `MEMPHIS_SELF_MODIFY_ALLOW_RUST=1`).

### P2 — ecosystem expansion (poza ~/memphis/)

#### F. **Tier-3 unlocks fs writes outside ~/memphis/ but no first-class API**
- Tier-3 currently lifts policy gates but operator still writes scripts via raw `memphis_exec bash` for outside-ecosystem ops.
- No tool like `memphis_external_write` że deklaruje cel + scope.
- **Refactor:** add `memphis_external_write` tool (tier-3 only) z `--path <abs>` + `--content` + `--reason <audit>`. Logs to system chain z `outside-ecosystem-write` action type. Pre-flight: check path NOT inside critical system dirs (/etc/, /usr/, /boot/) unless `--allow-system-paths=true` (extra confirmation step).
- **Files:** new `src/mcp/tools/external-write.ts`, audit policy in `src/security/external-write-policy.ts`.
- **Risk:** medium. Operator approves each tier-3 elevation explicitly — defense-in-depth.

#### G. **No plugin loading from outside repo**
- Skills live in `~/.memphis/skills-dev/` and `tools/skills/` (in-repo). External plugins (community-shared) not loadable.
- **Refactor:** plugin loader spec — `~/.memphis/plugins/<name>/manifest.json` + signed sig. Memphis can install via `memphis plugins install --url <github-release> --signer <did>`. Sandbox: tier-1 by default (read-only chains + tools), tier-2 with operator authorize. Federation chain tracks plugin endorsements.
- **Files:** new `src/plugins/` subsystem, `memphis plugins` CLI subcommand.
- **Risk:** medium. Sandbox boundary must be airtight. Initial scope: read-only + chain query only.

#### H. **Cross-host federation partial**
- `collective` chain exists for multi-agent sync. `memphis sync push/pull` commands exist. But no auto-discovery.
- **Refactor:** mDNS/Bonjour-based peer discovery on LAN. Heartbeat protocol. Chain delta sync (only new blocks since last sync). Encrypted via per-peer key exchange.
- **Files:** new `src/sync/peer-discovery.ts`, `src/sync/heartbeat.ts`. Plus `memphis_peer_announce` + `memphis_peer_subscribe` MCP tools.
- **Risk:** medium. Privacy: chains contain operator conversations — opt-in only, default OFF. Sharing scope per chain (operator chooses what to federate).

### P3 — vision / cognitive (longer-term)

#### I. **Cross-modal queries** (image + text in one turn)
- Today: Telegram photo handler runs vision separately, then routes text. No single-turn fusion.
- **Refactor:** turn-runtime accepts `attachments: [{type:'image'|'audio', path:...}]`. Provider adapter formats as multi-modal payload (Claude Vision, GPT-4V style). Local fallback: extract via memphis_media_ingest → text + reference into context.
- **Files:** `src/gateway/turn-runtime.ts` (attachments field), provider adapters (multi-modal wire format).

#### J. **Continuous fine-tuning loop**
- Kartograf v4 trains tonight on 5168 anchors. After training: install via `memphis kartograf install`. **Next iteration:** trajectory data from new conversations (since Kartograf v4 corpus cutoff) drives v5 corpus refresh. Auto-trigger every N days OR M new blocks.
- ToolSelector head (separate model on 969 tool-selection records) trains next.
- WatraLLM SFT (Qwen2.5-0.5B + QLoRA + BF16) requires Turing+ GPU — cloud (Vast.ai T4 ~$0.30/h) or operator HW upgrade.

---

## 4. Memphis self-coding strategy

**What Memphis CAN do today** (`memphis_self_modify` workflow):
1. Snapshot current state (`memphis backup create --tag pre-self-modify-<ts>`)
2. Branch off main (`fix/self-modify-<ts>`)
3. Edit TS files (operator scope: `src/**/*.ts`)
4. Run test gate (`pnpm typecheck && pnpm lint && pnpm test:unit`)
5. On green: commit to branch + push (does NOT merge to main — operator merges)
6. On red: rollback to snapshot, audit `self-modify-revert` chain
7. Tier-3 elevation required (`tier-3-passphrase`); 3h TTL

**Refactors Memphis CAN implement on its own:**
- P1.B (embed chunker) — pure TS in `src/infra/memory/embed-reindex.ts`
- P1.C (tier-3 persistence) — new file `src/security/tier3-session-persistence.ts` + hook into existing
- P1.D (soul schema) — `src/soul/manifest.ts` schema update + MCP tool args
- P2.F (memphis_external_write) — new MCP tool file
- P3.I (turn-runtime attachments) — turn-runtime + provider adapters (TS only)

**Refactors Memphis CANNOT implement on its own** (requires operator+Rust rebuild):
- P1.B (embed chunker) — partially Rust (`crates/memphis-embed`)
- P1.E (Rust self-modify) — self-bootstrap: Memphis needs Rust self-modify ability to add Rust self-modify ability (chicken-egg). Operator implements first cycle.
- P2.G (plugin loader, if sandbox uses native code)
- TUI shortcuts (P1.A, Rust crate)

**Concrete next 3-hour tier-3 cycle proposal (autonomous):**
- Operator elevates `/tier 3 <pass>`
- Memphis runs ordered sequence:
  1. P1.C tier-3 persistence (most-requested, scope ~300 LOC TS, ~30 min implement + test)
  2. P1.D soul schema extension (~100 LOC TS, ~20 min)
  3. P1.B embed chunker TS-side (~200 LOC TS, ~30 min; Rust side deferred to next operator-Rust window)
- Single PR per refactor, descriptive commit messages, test-gated
- Operator reviews PRs in morning, merges or requests changes
- Total: 3 refactors in 3-hour budget, all reversible

---

## 5. Tier-3 outside ecosystem — 3h coding window

**Use case:** operator wants Memphis to write external scripts/configs/services on their behalf within the 3h tier-3 window.

**Current state:**
- Tier-3 lifts `--scope ~/memphis/` restriction
- `memphis_exec` (bash) can do anything operator can do (via spawn)
- No structured "external write" path — operator manually crafts bash commands

**Proposed concrete tasks for tier-3 window:**

| Task | Memphis would do | Outside ~/memphis/ ? |
|---|---|---|
| Add systemd timer for backup cron | Write unit file to `~/.config/systemd/user/`, `systemctl --user enable --now`, audit | YES |
| Install helper CLI shortcut | Symlink `~/.local/bin/m` → `memphis`, update PATH note | YES |
| Set up Docker compose for Memphis cluster | Write `docker-compose.yml` to `~/memphis-cluster/`, `docker compose up -d`, validate ports | YES |
| Mount cloud storage for backup | Write `~/.config/rclone/rclone.conf` (vault-stored creds), test rclone sync | YES |
| Configure Caddy reverse proxy for HTTP | Write Caddyfile, restart caddy via sudo (operator confirms) | YES |
| Add ssh authorized_keys for federation peer | Write `~/.ssh/authorized_keys` line, test ssh handshake | YES |

**Refactor needed:** `memphis_external_write` tool (P2.F) + `memphis_external_systemctl` tool + `memphis_external_pkg_install` tool — each tier-3-gated, each writes audit event, each lets Memphis declare intent before execution.

---

## 6. Concrete priority order (next 7 days)

| # | Refactor | LOC | Files | Memphis self-modify? | Days |
|---|----------|-----|-------|---------------------|------|
| 1 | P1.C tier-3 persistence | ~300 TS | 2 | ✅ yes | 1 |
| 2 | P1.D soul schema extension | ~100 TS | 2 | ✅ yes | 0.5 |
| 3 | P1.B embed chunker (TS only) | ~200 TS | 2 | ✅ yes | 1 |
| 4 | P2.F memphis_external_write tool | ~250 TS | 3 | ✅ yes | 1 |
| 5 | P1.A TUI voice/image shortcuts | ~400 Rust + 200 TS | 4 | ❌ operator+Rust | 2 |
| 6 | P1.B embed chunker (Rust side) | ~300 Rust | 1 | ❌ operator+Rust | 1 |
| 7 | P3.I turn-runtime multi-modal attachments | ~500 TS | 5 | ✅ yes | 2 |
| 8 | P2.G plugin loader scaffold | ~600 TS | 6 | ✅ yes | 2-3 |
| 9 | P1.E Rust self-modify enable (bootstrap) | ~200 TS | 2 | ❌ operator+Rust (first cycle) | 1 |

**Total estimate:** ~10 days work, ~3500 LOC, 7 PRs (some bundled). Memphis can do ~60% autonomously; remaining 40% requires operator-driven Rust rebuilds.

---

## 7. Memphis ecosystem expansion vision

**Today:** Memphis is single-host runtime + Telegram bot for one operator.

**Y1 Q3+:**
- Multi-host federation via collective chain (consent-gated chain sharing)
- Plugin marketplace (signed plugins, federation chain endorsement = trust graph)
- Cross-modal cognition (image+audio+text in one turn)
- Continuous learning loop (Kartograf v4 → ToolSelector → WatraLLM SFT → trajectory mining → v5 corpus)
- Tier-3 unlock for outside-ecosystem ops (audit-trailed, operator-confirmed for risky paths)

**Y1 Q4+:**
- Agora marketplace (issues #153-161) — discovery, attestations, stake, reviews
- Multi-operator collaboration (per-chain ACLs, federated identity via DID)
- Voice-first interface (always-on Whisper STT, low-latency Piper TTS, wake word detection)

**Y2:**
- WatraLLM self-trained (operator-specific LoRA via nightly trajectory data)
- Cross-device sync (phone via Telegram = ambient access, laptop TUI = focused work)

---

## 8. Today's loose-ends recap (don't lose track)

- Training scheduled `Mon 2026-05-11 23:00 CEST` (timer `kartograf-full-train.timer`)
- Open PRs: **#562** (doctor docs whitelist), **#563** (training data curation docs), **#564** (training stack DeBERTa-v3-large)
- Operator pending: re-add tier-3 (passphrase OR reset via recovery flow z `tyle` answer)
- Daemon: healthy on qwen2.5:0.5b (cogito:3b cgo crash on Maxwell)
- Vault: clean re-init z `xep624624&A` passphrase + Q&A `ile?/tyle` configured

---

**Last updated:** 2026-05-11 16:30 CEST.
**Generated by:** Claude Code session in auto mode, operator request "Pomysl calosciowo. Zadeklaruj poprawki. Zaproponuj refactory."
