# Workspace Agent Guide

This file contains Memphis-managed workspace context for agent tools.

<!-- memphis:context:start -->
## Memphis Workspace Context

- workspace: `memphis`
- purpose: Shared MemphisOS workspace for supervised, auditable agent work.
- notes dir: `notes/`
- memory dir: `memory/`
- apps dir: `apps/`
- preferred formats: `markdown, json`

## Working Rules
- Prefer local-first, auditable, and reversible changes.
- Treat secrets as vault-managed values, not committed files.
- Keep human-facing plans and notes in Markdown.
- Use MemphisOS as the control plane; keep vendor-specific integrations downstream.
<!-- memphis:context:end -->

## Local Notes

Add tool-specific notes below this line. Memphis only manages the block above.

---

## Runtime profile — Memphis + MiniMax (Mavis)

> Authored by Mavis (MiniMax-M3), 2026-09-22. For all future agents
> working on this host.

### Operator

- **Name:** Wodzu (Marcin Kukla) — git `wodzu@memphis.local`
- **Language:** Polish for casual chat; English for code/docs/postmortems.
  Long-form technical docs are usually English; ad-hoc operator-facing
  notes are usually Polish.
- **Style:** terse, direct. Uses colloquial fragments ("lec", "dobra").
  Won't say "thanks" or "please" — just wants the result and the reasoning.
- **Confidence level:** high. Treats agents as peers, not assistants.
  Asks "przeczytaj najpierw" / "zrób jak uważasz" — expects the agent
  to read code first and own the decision, not ask for step-by-step approval.
- **Commits:** signs as `Wodzu (Marcin Kukla)`. Co-authored-by used when
  multiple agents contributed (see commit `398fc6b` for precedent).

### Project layout (this host)

| Path                                       | What                                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `/home/memphis/`                           | Workspace root. Operator home dir.                                                                                                             |
| `/home/memphis/memphis/`                   | Memphis repo (Node.js + Rust NAPI). Git branch: `feat/phase-L-offline-invariant`.                                                              |
| `/home/memphis/memphis/.env`               | Runtime secrets. **GITIGNORED. Never commit. Never print raw.**                                                                                |
| `/home/memphis/memphis/src/`               | TypeScript source. Compiled to `dist/` (gitignored).                                                                                           |
| `/home/memphis/memphis/dist/`              | Compiled output. Gitignored. Regenerate with `npm run build`.                                                                                  |
| `/home/memphis/memphis/skills/`            | Skill catalog (bash scripts + SKILL.md). Each skill is a folder.                                                                               |
| `/home/memphis/memphis/docs/postmortems/`  | Postmortems in operator's preferred format (see template below).                                                                               |
| `/home/memphis/memphis/tests/integration/` | Vitest integration tests. Includes `chain-format-compat.test.ts` — run this after touching `chain-adapter`.                                    |
| `/home/memphis/memphis/.memphis/`          | Live runtime data (DO NOT touch unless restoring).                                                                                             |
| `/home/memphis/.memphis/`                  | Runtime state — chains, vault, halt/, audit/, config/, logs/, backups/. **Audit `~/.memphis/audit/` is append-only** (JSONL since 2026-09-22). |
| `/home/memphis/.minimax/`                  | Mavis (current AI runtime) config + sessions + caches.                                                                                         |
| `/home/memphis/.config/systemd/user/`      | systemd user units. `memphis.service`, `memphis-halt-integrity.{timer,service}`, etc.                                                          |

### Critical paths for runtime triage

| Symptom                 | Look here                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memphis won't boot      | `journalctl --user -u memphis.service --since "10 min ago"`, then `~/.memphis/boot-failures.json`                                                    |
| Chain integrity failure | `~/.memphis/chains/` — look for non-conforming dirs (no `hash`/`prev_hash`). `MEMPHIS_CHAINS_ALLOWLIST` skip list applied at `chain-adapter.js:789`. |
| Halt audit issues       | `~/.memphis/audit/halt/events.jsonl` (post-2026-09-22 — was `~/.memphis/chains/halt/` before, see incident below).                                   |
| LLM provider down       | `~/.memphis/logs/memphis.log`, then `memphis providers health`.                                                                                      |
| Telegram not delivering | `~/.memphis/state/telegram-attachments/`, `~/.memphis/logs/` for `memphis-telegram`.                                                                 |

### Conventions

- **Commits:** conventional commits (`fix(...):`, `feat(...):`, `ci(...):`).
  Long descriptive body when the change is non-trivial. Cross-link the
  postmortem file by path. Co-authored-by when multiple agents contributed.
- **Postmortems:** in `docs/postmortems/YYYY-MM-DD-<slug>.md`. Template
  matches `2026-09-21-soul-append-and-deep-restart.md`:
  TL;DR → Timeline → Root cause → Evidence → Resolution → Lessons learned
  → Open questions → TL;DR for future sessions → Follow-ups → Anti-confab.
- **Code style:** see `package.json` scripts (`npm run lint`, `npm run
format:check`). Tests live in `tests/`, organized by `unit/` /
  `integration/`. New bash skills need a `SKILL.md` + scripts, plus a
  smoke test if they touch persistent storage.
- **Secrets:** `MEMPHIS_*` env vars in `.env` are gitignored. Never
  print raw `.env` to logs — redact `TOKEN|PASSWORD|KEY|SECRET|PAT`
  before display (existing pattern in `.minimax/permission.json`).

### Lessons learned — must-know for any future incident

1. **Chain integrity check is BOOT-time only.** New blocks written
   during a running session are not re-validated until next BOOT.
   So a sidecar writer that drops non-conforming blocks under
   `~/.memphis/chains/<dir>/` will silently corrupt the runtime and
   crash it on next restart. Always: validate write path before
   allowing a sidecar to write under `chains/`.
2. **Sidecar storage MUST NOT live under `chains/`.** Anything that
   isn't a real chain (audit logs, halt checks, embedding dumps) goes
   under `~/.memphis/audit/` (JSONL append-only) or `~/.memphis/logs/`.
   The `MEMPHIS_CHAINS_ALLOWLIST` env var (set in `.env`) limits what
   `chain-adapter.ts::verifyChainIntegrity` scans; unknown dirs are
   skipped with a warning. Don't rely on the allowlist alone — the
   primary fix is "don't write under chains/".
3. **`RestartPreventExitStatus` does work on this host in user-mode
   systemd.** Verified with `process.exit(102)` test (see postmortem
   2026-09-22 §1). Open question: why 298-reboot storm during the
   original incident. Likely a pre-reboot systemd version.
4. **Hard rate limit (`StartLimitBurst=5, StartLimitIntervalSec=300`)
   is the belt-and-suspenders fallback.** Lives in `[Unit]` of
   `memphis.service`, not `[Service]`. systemd-analyze verify must
   pass after edits.
5. **Skills in `skills/` should dry-run before going live.** Add a
   `compat.test.sh` to each new skill that asserts any persistent
   write either (a) lives outside `chains/` or (b) passes
   `memphis chain verify --strict`. Defer until B2 lands.
6. **`scripts/chain-integrity-sweep.mjs`** exists for offline chain
   sweep — used by `memphis-chain-integrity-sweep.timer` (hourly).
   Pin contract: see `tests/integration/chain-invariant.test.ts`.

### How to start work on this project

1. `git -C /home/memphis/memphis status` — see if anything's uncommitted.
2. `git log --oneline -5` — recent context.
3. `journalctl --user -u memphis.service --since "5 min ago" --no-pager | tail -20`
   — runtime health.
4. `curl -s http://127.0.0.1:3000/health | jq '.status,.runtime.chainMemory.integrity'`
   — chain memory health.
5. Read the most recent postmortem in `docs/postmortems/` — operator
   expects you to be aware of in-flight incidents.
6. Touch only what you can revert. Prefer staged changes over big-bang
   rewrites. Backup any file you intend to modify heavily
   (`cp file file.bak-$(date +%Y%m%d-%H%M%S)`).

### Things to NEVER do

- Don't commit `~/.memphis/.env`, `.tier2-passphrase`, `.github-pat`,
  `vault-state.json`, `vault-entries.json`, or `case-index.sqlite`.
- Don't `git push` to `main` without an explicit PR/operator go-ahead.
- Don't `rm -rf` outside `/tmp` or `~/.memphis-backup-*` without an
  explicit operator instruction.
- Don't edit `dist/` — gitignored, regenerated from `src/`. If you
  need a runtime-only patch (like the A2 allowlist) and don't want to
  rebuild, edit `dist/` AND `src/` together and commit only `src/`.
- Don't add `MEMPHIS_*` env vars to `.env` without updating
  `chain-adapter.ts` (or whichever code reads them) to use them —
  silent unknown env vars become future foot-guns.

---

## Synjar Knowledge Base — shared brain for agents

Marcin runs a local Synjar instance at `http://localhost:6200` (LAN: `http://10.0.0.60:6200`)
that serves as the shared knowledge base for humans and agents. Every agent that
collaborates on Memphis / Watra should read and write through this base so the
team can coordinate without losing context between conversations.

### Workspaces (7)

| Workspace      | Purpose                                                         |
| -------------- | --------------------------------------------------------------- |
| `core-memphis` | Architecture, system design, runtime docs                       |
| `strategy`     | Vision, roadmaps, business, market, Watra brand                 |
| `research`     | External inspirations, links, tech stacks, literature           |
| `ops`          | Runbooks, CLI/API reference, install, release notes             |
| `decisions`    | ADRs, plans, meta-decisions, memory                             |
| `agent-notes`  | Inter-agent scratchpad, handoffs, TODOs                         |
| `inbox-human`  | LAN drop-zone: humans upload raw material for agents to analyse |

Workspace IDs are in `_Watra/workspaces.json` on this host (gitignored).

### Agents (5 accounts + marcin)

Each agent has its own synjar user. Credentials live in
`_Watra/agent-credentials.json` (gitignored, local-only):

| Agent             | Email                          | Role   | Intended responsibilities                      |
| ----------------- | ------------------------------ | ------ | ---------------------------------------------- |
| `claude-code`     | `claude-code@agents.local`     | ADMIN  | Full read/write — implementation work          |
| `codex`           | `codex@agents.local`           | MEMBER | Reviews; writes to `decisions` + `agent-notes` |
| `hermes`          | `hermes@agents.local`          | MEMBER | Messaging / orchestration notes                |
| `openclaw`        | `openclaw@agents.local`        | MEMBER | Tooling / external-agent exchanges             |
| `memphis-runtime` | `memphis-runtime@agents.local` | MEMBER | Runtime reads (future: MCP tool bridge)        |
| `marcin`          | `marcin@watra.local`           | OWNER  | Operator, final arbiter                        |

Login to get a JWT:

```bash
curl -sS -X POST http://localhost:6200/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<email>","password":"<pass>"}'
```

Access tokens expire in 15 min; use the `refreshToken` or re-login.

### Handoff protocol — how agents exchange notes

**Reading:** every agent, at the start of a task, searches `agent-notes` for
documents tagged `to:<self>` with no `closed:*` tag. Example:

```bash
GET /workspaces/<agent-notes-id>/documents?tags=to:claude-code
```

Unread notes are the agent's inbox.

**Writing:** when an agent needs to hand work to another agent, it creates a
document in `agent-notes` whose body starts with a 3-line frontmatter block:

```
source: <agent-name>
date: <ISO-8601>
refs: <chain-block-id | PR#N | file:path:line | url>
```

and whose tags include: `from:<self>`, `to:<recipient-agent>`, `re:<topic>`,
optional `status:open` / `status:blocked` / `priority:high`.

**Closing:** when a note is acted on, the recipient replaces `status:open`
with `status:closed` (or `status:wontfix`) — this keeps the inbox clean and
makes a simple "what changed" audit trail possible.

### Search

Semantic RAG search across any workspace the agent is a member of:

```
POST /workspaces/<id>/search   { "query": "..." }
```

Cross-workspace search at `/search` (global) — respects RLS, so only
workspaces the caller is a member of are searched.

### Frontmatter convention for ingested documents

All bootstrap-ingested docs carry:

- `source:bootstrap` — initial 2026-04-18 ingest from local filesystem
- `ingested:<YYYY-MM-DD>` — date of first ingest
- `hash:<sha256[:12]>` — content hash for idempotent re-ingest

Agents writing new docs should add at minimum:

- `source:<agent-name>` (instead of `source:bootstrap`)
- `topic:<keyword>` (searchable domain)

### Scripts

Utility scripts live in `/home/memphis/synjar/scripts/`:

- `ingest.py` — single-file ingest with polling + idempotent hash tag
- `run-bootstrap-ingest.sh` — iterates `bootstrap-manifest.tsv` for bulk ingest
- `bootstrap-manifest.tsv` — source-of-truth mapping (file → workspace + tags)

### Embedding stack (2026-04-18, final for this host)

- **Model:** Ollama `all-minilm` (22M params, 384-dim). Chosen after
  `nomic-embed-text` (137M) hung pathologically on >350-char inputs on
  this host's CPU (Intel i3-2120, 2011).
- **Chunk size:** 200 GPT-tokens (~800 chars), ≤ `all-minilm`'s 256-token
  context ceiling with margin.
- **Sub-batch:** 4 chunks per `/api/embed` call + 90s per-call timeout with
  `AbortController`. Prevents Node fetch socket timeout on batch hangs.
- **`num_ctx: 2048`** passed in Ollama request → overrides Ollama's default
  256 so any chunk within the model's real context window goes through.
- **Perf on this box:** 20 KB markdown doc processes in ~20-40 s end-to-end
  on CPU. Will be ~1-2 s after CUDA install (see `_Watra/_cuda-install-guide.md`).

### Hardware recommendations (for any synjar self-host)

- **Min:** any x86_64 CPU with AVX (every chip since 2013).
- **Recommended:** NVIDIA GPU GTX 660+ (≥ 4 GB VRAM) with CUDA drivers, or
  Apple M-series, or AMD GPU with ROCm.
- **Without GPU on old CPU:** use `all-minilm` (22M), chunk 200 tok, expect
  slow ingest but still usable. Avoid `nomic-embed-text` — it hangs.

### Known limits (as of 2026-04-18)

- **SMTP disabled** (`.env`) because upstream synjar ships without the
  `workspace-invitation.hbs` template — invite + accept-invite flow still
  works because SMTP queueing is skipped when `SMTP_HOST` is unset. File
  an upstream issue (`thesynjar/synjar`) separately.
- **LLM smart chunking** still uses OpenAI key → falls back to fixed-size
  on 401. Sovereign swap (Ollama `qwen3.5:0.8b` via chat endpoint) is a
  separate future patch.
- **LAN CORS allowlist:** `http://10.0.0.60:6200` and `:6210` (web) are open.
- **Self-hosted registration disabled** after first user (Marcin). LAN
  humans join via invite token issued by the OWNER.

### Quick-verify commands

```bash
# Is API up?
curl -sS http://localhost:6200/health

# What embedding is Ollama loading?
curl -sS http://localhost:11434/api/ps | python3 -m json.tool

# DB state:
docker exec synjar-dev-postgres psql -U postgres -d synjar_dev \
  -c 'SELECT "processingStatus", COUNT(*) FROM "Document" GROUP BY 1;'

# Fresh JWT (operator credentials live in $SYNJAR_OWNER_EMAIL + $SYNJAR_OWNER_PASSWORD env vars or in a local .env file — NEVER commit them to this repo):
curl -sS -X POST http://localhost:6200/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$SYNJAR_OWNER_EMAIL\",\"password\":\"$SYNJAR_OWNER_PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])'
```

> ⚠️ **2026-04-19 SECURITY NOTICE:** an earlier revision of this file
> committed a literal Synjar OWNER password (`marcin@watra.local`) to the
> public repo. Even though the Synjar instance is local-only, that
> credential lived in git history and on every public clone. The owner
> password has been rotated; agents and operators must re-set local
> `$SYNJAR_OWNER_PASSWORD` after pulling. The git-history scrub
> (filter-branch / BFG) is a separate operator action — see `git log
--all -S 'WatraAdmin'` to confirm which historical commits still expose
> it.
