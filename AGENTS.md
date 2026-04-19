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

## Synjar Knowledge Base — shared brain for agents

Marcin runs a local Synjar instance at `http://localhost:6200` (LAN: `http://10.0.0.60:6200`)
that serves as the shared knowledge base for humans and agents. Every agent that
collaborates on Memphis / Watra should read and write through this base so the
team can coordinate without losing context between conversations.

### Workspaces (7)

| Workspace | Purpose |
| --- | --- |
| `core-memphis`  | Architecture, system design, runtime docs |
| `strategy`      | Vision, roadmaps, business, market, Watra brand |
| `research`      | External inspirations, links, tech stacks, literature |
| `ops`           | Runbooks, CLI/API reference, install, release notes |
| `decisions`     | ADRs, plans, meta-decisions, memory |
| `agent-notes`   | Inter-agent scratchpad, handoffs, TODOs |
| `inbox-human`   | LAN drop-zone: humans upload raw material for agents to analyse |

Workspace IDs are in `_Watra/workspaces.json` on this host (gitignored).

### Agents (5 accounts + marcin)

Each agent has its own synjar user. Credentials live in
`_Watra/agent-credentials.json` (gitignored, local-only):

| Agent | Email | Role | Intended responsibilities |
| --- | --- | --- | --- |
| `claude-code`     | `claude-code@agents.local`     | ADMIN  | Full read/write — implementation work |
| `codex`           | `codex@agents.local`           | MEMBER | Reviews; writes to `decisions` + `agent-notes` |
| `hermes`          | `hermes@agents.local`          | MEMBER | Messaging / orchestration notes |
| `openclaw`        | `openclaw@agents.local`        | MEMBER | Tooling / external-agent exchanges |
| `memphis-runtime` | `memphis-runtime@agents.local` | MEMBER | Runtime reads (future: MCP tool bridge) |
| `marcin`          | `marcin@watra.local`           | OWNER  | Operator, final arbiter |

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

# Fresh JWT:
curl -sS -X POST http://localhost:6200/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"marcin@watra.local","password":"WatraAdmin!2026"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])'
```

