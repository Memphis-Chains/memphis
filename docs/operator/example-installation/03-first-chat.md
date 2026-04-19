# 03 — First chat: CLI + tier-2 tool elevation

> ⚠️ **SYNTHETIC EXAMPLE** — chat outputs and tool-dispatch traces below
> are illustrative reconstructions. Real LLM responses, token counts,
> exact prompt text, and tier-2 elevation prompts will differ. The
> top-level command shapes (`memphis chat`, `memphis journal`,
> `memphis recall`, `memphis tui`) are real top-level commands per the
> v1.3.0 dispatcher; verify subcommand options with `memphis <command> --help`.

> Continues from `02-first-run.md`. By the end you've talked to Memphis,
> stored a memory, and recalled it semantically.

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

## Store a memory (chain append)

```
$ memphis journal "First impressions: install was smooth, doctor passed, Ollama is fast."

[memphis] Appended to journal chain:
  index: 1
  hash:  a1b2c3d4e5f6... (sha256, 64 hex)
  size:  127 bytes
  duration: 12ms
```

## Semantic recall

```
$ memphis recall "what did I think about the install?"

[memphis] mode: semantic
[memphis] embeddings: ollama (nomic-embed-text)
[memphis] hits: 1

[1] score 0.87 — chain: journal, block 1
    "First impressions: install was smooth, doctor passed, Ollama is fast."
    tags: [memory]
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
version v1.3.0.
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
000000.json    ← genesis
000001.json    ← "First impressions..."

$ memphis chain audit --json
{
  "journal":     { "blocks": 2, "integrity": "ok" },
  "decisions":   { "blocks": 1, "integrity": "ok" },
  "reflections": { "blocks": 1, "integrity": "ok" },
  "patterns":    { "blocks": 1, "integrity": "ok" },
  "cases":       { "blocks": 1, "integrity": "ok" },
  "system":      { "blocks": 4, "integrity": "ok" },
  "proactive":   { "blocks": 1, "integrity": "ok" }
}
```

Continue to [`04-vault-setup.md`](./04-vault-setup.md).
