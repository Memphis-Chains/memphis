# 03 — First chat: CLI + tier-2 tool elevation

> ⚠️ **SYNTHETIC EXAMPLE** — chat outputs and tool-dispatch traces below
> are illustrative reconstructions. Real LLM responses, token counts,
> exact prompt text, and tier-2 elevation prompts will differ.
>
> **Commands verified real (post-Codex 2026-04-19):** `memphis chat`,
> `memphis ask`, `memphis search`, `memphis embed search`, `memphis chain
> verify`, `memphis chain rebuild`, `memphis tui`. The previous revision
> referenced `memphis journal` and `memphis recall` as top-level commands
> — those are NOT registered (no top-level handler). To write/read
> memory through the CLI, use `memphis chat` (which dispatches MCP tools
> like `memphis_journal` / `memphis_recall` internally) or invoke the MCP
> tools directly from another MCP client. Verify subcommand options with
> `memphis <command> --help`.

> Continues from `02-first-run.md`. By the end you've talked to Memphis,
> exercised semantic search, and elevated to tier-2 for a write tool.

## Local-fallback chat (no network needed)

```
$ memphis chat --input "Hello, Memphis. Are you operational?"

[memphis] provider: local-fallback
[memphis] tokens in: 8  out: 23  duration: 0.4s

Hello! Yes, I'm operational. Local-fallback runtime is active — minimal
echo-mode reply. For real LLM responses, ensure Ollama is running and
set DEFAULT_PROVIDER=ollama (or another configured provider).
```

## Ollama chat (local LLM)

```
$ memphis chat --input "Reply with the literal string OK." --provider ollama

[memphis] provider: ollama  model: cogito:3b
[memphis] tokens in: 9  out: 2  duration: 1.8s

OK
```

## Store a memory (via chat → MCP tool dispatch)

There is no top-level `memphis journal` command. To write to the journal
chain from CLI, ask the chat runtime to dispatch the `memphis_journal`
MCP tool:

```
$ memphis chat --input "Save to journal: 'First impressions: install was smooth.'"

[memphis] provider: ollama
[memphis] tool requested: memphis_journal (tier 0)
[memphis] tool dispatched: memphis_journal(content: "First impressions: install was smooth.")
[memphis] Appended to journal chain — index 1, hash a1b2c3d4e5f6...
[memphis] reply: Saved that memory to your journal chain.
```

## Search memory

`memphis search` is the FTS5 exact-search front-end; `memphis embed
search` is the semantic (embedding-based) front-end:

```
$ memphis search --query "install"

[memphis] mode: exact (FTS5)
[memphis] hits: 1

[1] chain: journal, block 1
    "First impressions: install was smooth."

$ memphis embed search --query "what did I think about the install?" --top-k 3

[memphis] mode: semantic
[memphis] embeddings: ollama (nomic-embed-text) — 384-dim
[memphis] hits: 1

[1] score 0.87 — chain: journal, block 1
    "First impressions: install was smooth."
```

## Tier-2 tool — operator passphrase prompt

```
$ memphis chat --input "Read the file ~/memphis/README.md and summarize it"

[memphis] provider: ollama
[memphis] tool requested: memphis_code_read (tier 2)
[memphis] elevation required for tier 2

Operator passphrase:
> ********************
[memphis] tier-2 elevation granted (TTL: 15 min)
[memphis] tool dispatched: memphis_code_read(path: ~/memphis/README.md)
[memphis] reply:

The README describes Memphis as a sovereign AI runtime — local-first,
chain-backed memory, vault-encrypted secrets, with TUI cockpit and
Telegram gateway. Quick start: `memphis init` after install. Current
version v1.4.0.
```

## TUI cockpit

```
$ memphis tui

(opens ratatui-based terminal interface)
- Top bar: [Mode:A] ollama/cogito:3b · PULSE:healthy · session:abc123
- Tabs: Overview · Chat · Memory · Sessions · Vault · Cases · System
- Press 'q' to quit, '?' for help
```

State after this session:

```
$ ls ~/.memphis/chains/journal/
000000.json    ← genesis (from memphis init)
000001.json    ← "First impressions: install was smooth."

$ memphis chain verify --json
{
  "ok": true,
  "chains": {
    "journal":     { "blocks": 2, "integrity": "ok" },
    "system":      { "blocks": 4, "integrity": "ok" }
  },
  "note": "Other canonical chains (decisions, reflections, patterns, cases, proactive, collective) created lazily on first write."
}
```

> Valid `memphis chain` subcommands per `src/infra/cli/handlers/storage.handler.ts`:
> `import_json`, `export`, `verify`, `rebuild`, `diagnose`,
> `rebuild-hashes`, `restore`, `migrate`. The earlier `memphis chain
> audit` reference was incorrect — `verify` (per-block integrity) +
> `diagnose` (deeper introspection) are the real commands.

Continue to [`04-vault-setup.md`](./04-vault-setup.md).
