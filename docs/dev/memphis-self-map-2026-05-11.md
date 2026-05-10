# Memphis Codebase Self-Map — 2026-05-11

**Purpose:** Machine-readable index of Memphis architecture. Bot reads this
via `memphis_code_read --path /home/memphis/memphis/docs/dev/memphis-self-map-2026-05-11.md`
at session start to avoid confabulation ("this code doesn't exist") before
asking operator for confirmation.

**Audience:** Memphis Agent (self). For human operator's architecture view, see
`memphis-architecture-2026-05-11.md`.

---

## 1. Telegram Media Bridge — Voice + Photo Handling (EXISTS, not a gap)

**File:** `/src/gateway/channels/telegram.ts` (1000+ lines, all handlers inline)

### Voice Input Pipeline (line 751+)
```
bot.on('message:voice') → speechToText() → agent → textToSpeech() → sendVoice()
```
- `:751` `bot.on('message:voice', async (ctx) => {...})`
- `:779` `const sttResult = await speechToText(audioBuffer, voiceConfig)`
- `:807-815` Transcribed text sent through agent handler with `pendingVoiceReply.add(chatId)` flag
- `:963-996` Checks `pendingVoiceReply` set, quota-gated via `checkTtsQuota()`, calls `textToSpeech()` → `bot.api.sendVoice()`

### Photo + Vision Pipeline (line 834+)
```
bot.on('message:photo') → ingestMedia(tempPath, 'image') → vision + OCR → handler()
```
- `:834` `bot.on('message:photo', async (ctx) => {...})`
- `:864-876` Telegram file fetch → temp file on disk
- `:877` `const result = await ingestMedia(tempPath, { kind: 'image', surface: 'telegram' }, process.env)`
- `:881` `visionDescription = result.payload.description`
- `:882-883` `ocrText` + `ocrConfidence` from payload (Tesseract)
- `:903-907` `attachmentBrief` constructed with vision + OCR
- `:910-918` `await handler()` with brief injected into text

**Anti-pattern alert:** 2026-05-10 bot powiedział "Telegram handler obsługuje TYLKO tekst" → koder brief z konfabulacją (T1 false). Bot użył `memphis_grep -r 'photo|video|document' src/gateway/channels/` i widać 0 hitów BO PATTERN użyty był zły — kod jest, używa `message:photo` notation (z dwukropkiem). Naucz się: `grep` z konkretnym call site shape (`bot.on('message:`) nie generic word.

---

## 2. Voice Service — STT + TTS Adapters

**File:** `/src/gateway/voice/voice-service.ts`

### Voice Config Resolution
- `resolveVoiceConfig()` `:81-120` → `VoiceConfig`
- `:94-100` Three modes: `'cloud'` (HF API) / `'local'` (whisper.cpp on `:9000`) / `'auto'` (default — local if HF token absent)
- Env vars:
  - `MEMPHIS_VOICE_MODE` = 'cloud' | 'local' | 'auto'
  - `WHISPER_SERVER_URL` (default :9000)
  - `PIPER_SERVER_URL` (default :5500)
  - `HUGGINGFACE_API_TOKEN` (cloud STT)
  - `GOOGLE_TTS_API_KEY` (cloud TTS fallback)

### STT Adapter
**File:** `/src/gateway/voice/local-whisper-adapter.ts`
- Export: `speechToTextLocal(audioBuffer: Buffer, voiceConfig: VoiceConfig): Promise<SttResult>`
- Routes: Cloud HF or local server per `voiceConfig.route`
- Result: `{ text: string; error?: string }`

### TTS Adapter
**File:** `/src/gateway/voice/local-piper-adapter.ts`
- Export: `textToSpeechLocal(text: string, voiceConfig: VoiceConfig): Promise<TtsResult>`
- Providers: HuggingFace (`facebook/mms-tts-pol`) or Google TTS (`pl-PL-Standard-B`) lub local Piper na :5500
- Result: `{ audio: Buffer; contentType: string; error?: string }`

### Voice Policy
**File:** `/src/gateway/voice/voice-policy.ts`
- TTS quota: `checkTtsQuota(chatId)` → daily limit
- User preference: `getVoicePreference(chatId)` / `setVoicePreference()` → persistent on/off toggle
- Quota enforcement at `telegram.ts:964-978`

---

## 3. Media Pipeline — Orchestrator + Adapters

**File:** `/src/gateway/media/orchestrator.ts`

### Entry Point
- `ingestMedia(filePath, options, rawEnv)` `:45-49`
- Kind detection `:51` auto z extension lub `options.kind`
- Scope: B3 = audio + image only; video is stub (B4 future)

### Audio Processing
- `/src/gateway/media/audio-adapter.ts`
- Export: `transcribeAudioFile(filePath, rawEnv): Promise<MediaPayload>`
- Flow: audio file → whisper-server (or HF) → text → journal chain entry

### Image Processing (Parallel)
**Vision:** `/src/gateway/media/vision-adapter.ts`
- Export: `describeImage(filePath, options, rawEnv): Promise<ImagePayload>`
- Provider: Ollama vision model (moondream / llava / granite3.2-vision)
- Output: `{ kind: 'image'; description: string }`

**OCR:** `/src/gateway/media/ocr-adapter.ts`
- Export: `extractTextFromImage(filePath, rawEnv): Promise<OcrResult>`
- Provider: Tesseract
- Output: `{ text: string; confidence: number; error?: string }`

### Chain Output
**File:** `/src/gateway/media/chain-output.ts`
- Export: `writeMediaToChains(payload, metadata, surface, rawEnv)`
- Writes: journal entries + case entries dla operator audit trail

---

## 4. Cognitive Models A–E

### Model A — Conscious Capture
**File:** `/src/cognitive/model-a.ts` + `model-a-types.ts`
- Purpose: Explicit decision/note/milestone recording
- Entry kinds: 'decision', 'note', 'milestone'
- API: `ModelA_ConsciousCapture.capture(input): Promise<ModelACaptureResult>`
- Output: Block w journal/decisions chain z signature

### Model B — Inferred Decisions
**File:** `/src/cognitive/model-b.ts`
- Purpose: Detects implicit decisions from behavior signals (git commits, file changes)
- Signals: Git history, activity patterns, commit messages
- Confidence: Weighted pattern matching
- Output: `InferredDecision[]` z category (strategic/tactical/technical), confidence, evidence

### Model C — Predictive Patterns
**File:** `/src/cognitive/model-c.ts`
- Purpose: Learns decision patterns from A+B history, generates predictive suggestions
- Input: Historical blocks from chains
- Output: `Prediction[]` z next-action suggestions, confidence
- Persistence: Pattern cache w `~/.memphis/model-c-patterns.json`

### Model D — Collective Coordination
**File:** `/src/cognitive/model-d.ts`
- Purpose: Multi-agent voting & consensus (Memphis ↔ Watra ↔ …)
- Primitives: `Proposal`, `Vote` (cryptographic signature), `DecisionResult`
- Output: `CollectiveDecision` z participants, approval status, execution record

### Model E — Meta-Cognitive Reflection
**File:** `/src/cognitive/model-e.ts`
- Purpose: Weekly introspection on own outputs, contradictions, blind spots
- Trigger: Scheduled (daily lub weekly per config)
- Output: `Reflection[]` z insights, recorded to reflection chain

---

## 5. Tool Registry Quick-Reference

**File:** `/src/gateway/tool-registry.ts` — 41 zarejestrowanych narzędzi

### Tier 0 (read-only, no approval)
- `memphis_journal` — Append journal entry
- `memphis_recall` — Vector semantic search across chains
- `memphis_search` — Literal phrase search across chains
- `memphis_decide` — Record decision
- `memphis_health` — Runtime health snapshot
- `memphis_self_describe` — **KRYTYCZNE**: Bot introspection (MUST call before "what can you do")
- `memphis_slo_status` — SLO snapshot (7-day window)
- `memphis_repair` — Idempotent state repair (chain integrity, migrations, indexes)
- `memphis_soul_read` — Read identity narrative (user/self/context)
- `memphis_soul_write` — Update identity narrative (UWAGA: schema NIE wspiera `nickname`, `location`, `identity` jako fields; activeWork = string nie array)
- `memphis_case_append` — Append case entry (Polish grammar roles)
- `memphis_case_query` — Relational query over case-index
- `memphis_chain_query` — Direct chain block reads with filters
- `memphis_loop_step` — Loop enforcement gate (deterministic, no I/O)
- `memphis_web_fetch` — GET public URL (30s timeout, 5-hop redirects)
- `memphis_presence` — Cross-surface activity snapshot
- `memphis_system_info` — Host + runtime fingerprint
- `memphis_providers` — Provider config introspection
- `memphis_config_show` — Show runtime config (redacted)
- `memphis_brave_search` — Brave Search API (requires `BRAVE_API_KEY`)
- `memphis_web_search` — DuckDuckGo search (no API key)
- `memphis_cognitive_mode_set` — Switch mode A–E

### Tier 2 (approval-required, sandbox-restricted)
**Memory/Code (sandbox: `~/memphis/` only):**
- `memphis_code_read` — Read files w `~/memphis/` (whitelisted boundary)
- `memphis_grep` — Regex search (ripgrep/grep)
- `memphis_glob` — File discovery by glob pattern

**Git:**
- `memphis_git` — Git subcommands (force-push + `--no-verify` denied even tier 3)

**Execution:**
- `memphis_test` — Run typecheck/lint/vitest/cargo test
- `memphis_build` — Auto-detect & run build (npm/cargo/python)
- `memphis_exec` — Shell command (gateway exec-policy denylist)
- `memphis_deploy` — Deploy orchestrator (snapshot→build→health→rollback)
- `memphis_package` — npm/cargo/apt/pip package operations
- `memphis_db` — SQLite query/execute/schema inspection
- `memphis_restart` — Restart runtime (tier-3 passphrase required)

**Files (sandbox `~/memphis/`, denylist `.env|vault-*|.git/|node_modules/`):**
- `memphis_fs_write` — Write/append/overwrite
- `memphis_fs_ops` — copy/move/delete/mkdir/stat (recursive)

**Self-modify (TIER-2 + TEST GATE):**
- `memphis_self_modify` — snapshot→branch→test→commit/rollback

**Media:**
- `memphis_media_ingest` — Process audio/image (transcribe + describe + OCR)

**Scheduling:**
- `memphis_cron` — Internal scheduled tasks (list/add/remove/enable/disable)
- `memphis_schedule` — Higher-level schedule operations

**Config:**
- `memphis_config_set` — Update one config key (secret fields: passphrase-gated)
- `memphis_config_reload` — Hot-reload mutable env fields
- `memphis_vault_get` — Tier-2 + audit chain

---

## 6. Anti-Confabulation Audit System

**File:** `/src/gateway/anti-confab-audit.ts` + `turn-runtime.ts:1038-1114`

### Phase 2 active (default `MEMPHIS_ANTICONFAB_PHASE=2`)
Warn-append: do replyu dodaje footer `[memphis: claim flagged as unverified — category: "phrase"]`.

### Rules (categories)
**Rule A — Persistence claims** (without memphis_journal/fs_write/self_modify call):
- Polish: `zapisałem`, `zapisane`, `tworzę plik`, `udało się`, `gotowe`
- English: `i saved`, `i created a file`, `i updated`, `creating file`

**Rule D — Search claims** (without memphis_code_read/grep/glob/recall/chain_query call):
- Polish: `przeszukałem`, `grepowałem`, `sprawdziłem kod`, `nie ma w src/`
- English: `i searched`, `i grepped`, `couldn't find in src/`

**Rule C — Capability claims** (without memphis_self_describe call):
- Enumerations: `i have access to`, `my available tools are`, `my tier grants`

**Rule E — Tool naming** (code-fence call to non-existent tool):
- 2026-05-10 incidents: `memphis_PROACTIVE_TELEGRAM_CHAT_ID` (env var), `memphis_PROMPT_ARCHITECTURE` (file name), `memphis_CAPS_USER` (caps user var) — env var / file name nie jest tool

**Rule guards:** Quote-context (`"…"`, `«…»`, `: …`) excluded by `looksQuoted()` in audit module.

---

## 7. Self-Modification Pipeline

**File:** `/src/mcp/tools/self-modify.ts`

### Workflow
1. **Snapshot:** Current tree → `~/.memphis/backups/` (backup manager)
2. **Branch:** Create isolated git branch
3. **Apply:** Write changes to files
4. **Test gate:** `runTestGate()` (typecheck + lint + vitest)
5. **Commit:** Pass → commit z intent + passphrase
6. **Rollback:** Fail → auto-revert to snapshot
7. **Audit:** Every attempt logged to case chain

### Path Validation
- Forbidden segments: `.env`, `vault/`, `.git/`, `node_modules/`
- Boundary: `~/memphis/` (no escape via symlink — realpath check)
- Dotfiles blocked (`.claude/`, `.env`, etc.)

### Passphrase Requirement
- Tier-2 tool + passphrase gate
- Test failure blocks commit regardless of approval
- Never bypass test gate dla "trivial" edits

---

## 8. Sandbox Boundaries — KEY FOR BOT

### Code Access
- `memphis_code_read`, `memphis_grep`, `memphis_glob` → restricted to `~/memphis/`
- 2026-05-10 incident: bot próbował `/root`, `/root/.memphis`, `/home/wvio/memphis` — all **HARD FAILED** z `Path 'X' is outside ~/memphis/`
- No escape via symlink (realpath check)

### Read-only Limits
- code_read tylko read; nie write. Pisanie przez fs_write/self_modify.

### Execution Limits
- `memphis_exec` → tier-2 + denylist (`src/gateway/exec-policy.ts`)
- Sensitive commands denied (system control, credential writes)
- Stdout/stderr capped at 64KB

### File Operations
- `memphis_fs_write` / `memphis_fs_ops` → deny vault/, keys/, system dirs
- No permission to write to `/etc/`, `/var/log/`, `~/.ssh/`
- Audit chain logs every path + mode

### Network
- `memphis_web_fetch` → surface policy controls (Telegram blocks by default)
- 30s timeout, 5-hop follow limit
- Blocked hosts: DNS-resolution failure surfaced jako "URL blocked: host could not be resolved"

### Vault Access
- `memphis_vault_get` → tier-2 + audit chain
- Secrets never logged in plaintext
- Cold-field changes wymagają restart

---

## 9. Surface Policy Tiers

### Default per Surface
- **CLI / MCP / TUI**: Tier 2 by default
- **Telegram**: Tier 2 (network tools blocked by default)
- **HTTP**: Tier 2 (surface policy controls tool access)

### Tier 3 Sessions
- Passphrase-gated, 3-hour TTL
- Tracked in shared `tier3-session` module (`src/security/tier3-session.ts`)
- Telegram gets lifecycle notifications: `expiring-soon` (5 min przed), `expired`, `revoked`
- Wymagane dla `memphis_restart`, `memphis_cognitive_mode_set`, full `MEMPHIS_AUTONOMY_MODE=full` writes outside `~/memphis/`

### Tier surface policy decode
- `tier 0` → `memory_recall`, `url_fetch`, `cognitive_prelude`, `memory_store_scanned_blocked`, `tools_blocked` (gateway turn persistence degraded)
- `tier 1` → niektóre blocked (`recalled_memory_blocked`)
- `tier 2` (default) → otwarte

---

## 10. Real Gaps (NOT YET IMPLEMENTED — these ARE real, unlike T1)

- **Tauri GUI** (`apps/memphis-gui/`) — Phase G not started, ~1-2 tyg pracy
- **Video processing** (B4) — stub w orchestrator `:86-102`, error message clear ("not implemented")
- **Phase P peer auth** — federated auth nie napisana
- **Kartograf model checkpoints** (Q2 N32) — deferred (weights nie w repo)
- **Soul schema extensions** — `nickname`, `location`, `identity`, `activeWork` array nie wsparte (operator hit 2026-05-10)
- **Provider cross-cascade beyond local-fallback** — Anthropic 400 fallback'uje na `local-fallback-v0` (stub), nie na Ollama (operator hit 2026-05-10 credit exhausted)

---

## 11. Anti-Pattern Warnings for Bot Sessions

### Rule T1: Don't claim "code doesn't exist" without grep verify
- 2026-05-10 incident: bot said "Telegram handler only text" → confab
- Reality: `:751 voice in`, `:834 photo in`, `:996 sendVoice out` all exist
- **Solution:** grep with multiple patterns (`bot.on`, `message:`, function names) ZANIM claim absence

### Rule E: Don't propose env var names as tool calls
- Wrong: ```memphis_DEBUG```, ```memphis_PROACTIVE_TELEGRAM_CHAT_ID```
- Right: `memphis_config_set --key MEMPHIS_PROACTIVE_TELEGRAM_CHAT_ID --value <id>`
- **Test:** memphis_self_describe.tools ma to w liście? Jeśli nie — formułuj jako tekst, nie code-fence

### Rule A: Don't say "saved/wrote/created" without calling the tool
- Wrong: "I wrote the file to disk"
- Right: Call `memphis_fs_write` THEN report the audit chain entry

### Rule C: Don't enumerate capabilities from training data
- Wrong: "You can call memphis_json_parse, memphis_xml_format, …"
- Right: Call `memphis_self_describe` first, quote its output

### Rule D: Always quote tool results when you called them
- 2026-05-10 incident: bot called `memphis_journal` 3x, got quotable fields, ignored them in reply
- Right: prefix `per memphis_recall: "..."` żeby anti-confab zobaczył quote

---

## 12. Solution-Search Heuristic (when operator asks "can you do X?")

Kolejność:
1. **`memphis_self_describe`** — effective tier, tool inventory, surface policy
2. **`memphis_grep`** z konkretną nazwą funkcji/symbolu w `src/`
3. **`memphis_code_read`** na file:line z grep wyniku
4. **`memphis_chain_query`** — operator history (poprzednie decyzje w tym obszarze)
5. **`memphis_recall`** — semantic, dla "czy operator kiedyś prosił o X"
6. **DOPIERO TERAZ** propose action lub claim "nie ma"

Skok od (1) do (6) bez weryfikacji = confab generator (T1 incident).

---

## 13. Key Files Index — Quick Reference

```
Entry:
  src/index.ts                         — bootstrap
  bin/memphis.js                       — CLI wrapper
  src/infra/cli/index.ts               — command dispatch

Gateway turn loop:
  src/gateway/turn-runtime.ts          — single-turn orchestration (1.4K LOC)
  src/gateway/agent-runtime.ts         — multi-turn planning
  src/gateway/tool-executor.ts         — tool dispatch (1.4K LOC)
  src/gateway/tool-registry.ts         — 41 tools catalog (1.3K LOC)
  src/gateway/system-prompt.ts         — prompt engineering (1.5K LOC)
  src/gateway/anti-confab-audit.ts     — confab detector

Providers:
  src/providers/anthropic/adapter.ts   — Claude (Opus 4.6 default + 4.7 fallback)
  src/providers/minimax/...             — MiniMax M2.7
  src/providers/glm/adapter.ts          — GLM-4
  src/providers/index.ts                — Ollama adapter (always available)
  src/providers/local-fallback/adapter.ts — deterministic stub (last resort)

Channels:
  src/gateway/channels/telegram.ts     — voice + photo + text (1000+ LOC)
  src/infra/http/server.ts             — HTTP
  src/infra/tui-host/                  — TUI host (Rust binary bridge)
  src/mcp/server.ts                    — MCP on :3001 (optional)

Storage:
  src/infra/storage/chain-adapter.ts   — TS wrapper for chains
  src/infra/storage/rust-chain-adapter.ts — NAPI bridge
  src/infra/storage/rust-embed-adapter.ts — embed (bulk + flush, Phase 1)

Cognitive:
  src/cognitive/model-{a,b,c,d,e}.ts   — 5 reasoning variants
  src/cognitive/proactive-assistant.ts — proactive Telegram pings

Security:
  src/security/vault-boundary.ts       — vault crypto cycle
  src/security/tier3-session.ts        — passphrase elevation
  src/security/runtime-security-events.ts — audit chain emitter

Media:
  src/gateway/media/orchestrator.ts    — entry: ingestMedia()
  src/gateway/media/{audio,vision,ocr}-adapter.ts

Voice:
  src/gateway/voice/voice-service.ts
  src/gateway/voice/local-whisper-adapter.ts
  src/gateway/voice/local-piper-adapter.ts
  src/gateway/voice/voice-policy.ts

MCP tools (39 files):
  src/mcp/tools/{journal,recall,search,decide,code-read,grep,glob,git,exec,
                 build,test,fs-write,fs-ops,self-modify,chain-query,
                 web-fetch,brave-search,web-search,health,health-check,
                 system-info,presence,providers,case-append,case-query,
                 soul,vault-get,cron,schedule,deploy,package,repair,
                 restart,self-describe,slo-status,media-ingest,
                 loop-step,config,db}.ts

Doctor:
  src/infra/cli/utils/doctor-v2.ts     — 58 checks across 6 tiers + Tier A architecture
```

---

## 14. Storage Layout `~/.memphis/`

```
chains/                      append-only blockchain memory
  ├─ journal/                raw events
  ├─ decisions/              decision tree
  ├─ reflections/            self-observation
  ├─ cases/                  learned patterns
  ├─ patterns/               behaviors (Model C cache)
  ├─ system/                 runtime state + security events
  ├─ collective/             federation
  ├─ insights/               semantic summaries
  └─ soul/                   identity blocks

config/
  ├─ soul-memory.json        bot identity (user/self/context)
  ├─ soul-manifest.json      autonomy mode, trust rules, tier-2 hash
  ├─ agent-profile.json      public profile
  ├─ scheduler/tasks.json    6 cron tasks
  └─ scheduler/logs/         per-task logs

vault-state.json             encrypted master key (pepper-wrapped)
vault-entries.json           encrypted secrets (master-key-encrypted)
data/memphis.db              SQLite (sessions, FTS5 exact-search 3000+ entries)
embed-index.json or .ndjson  embed vectors (Phase 1: NDJSON v2 opt-in)
logs/memphis.log             rotated runtime log
backups/                     backup snapshots (per memphis backup)
docs/                        operator-generated docs (bot's koder-brief'y też tu lądują)
```

---

**Last updated:** 2026-05-11 (post commit history + architecture recon by 3 parallel agents).
**Scope:** Memphis v1.8.0.
**For bot reading:** Call `memphis_code_read --path /home/memphis/memphis/docs/dev/memphis-self-map-2026-05-11.md` at session start to load this reference.
