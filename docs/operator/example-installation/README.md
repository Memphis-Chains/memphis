# Example Installation — reference walkthrough

> A worked example of installing Memphis on a clean PC and reaching a
> production-ready state. Use this alongside [`../install.en.md`](../install.en.md)
> (or [`../install.pl.md`](../install.pl.md) in Polish) — that doc is the
> canonical reference; this is the **happy-path transcript** so you know
> what success looks like.

## What's in this directory

| File                      | What it shows                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `01-fresh-install.md`     | One-liner installer run on a clean Ubuntu 24.04 box, with timing                              |
| `02-first-run.md`         | `memphis init` interactive session — what to type, what to expect                             |
| `03-first-chat.md`        | First chat through Telegram + CLI, vault prompt for tier-2 tools                              |
| `04-vault-setup.md`       | Adding API keys to vault, listing vault, recovery flow                                        |
| `05-health-snapshot.json` | Sample sanitized output of `memphis health --json` on a healthy install                       |
| `06-timing-baseline.txt`  | Step-by-step timing on Intel i3-2120 (2011, no GPU, 4 cores) — Memphis's lower hardware bound |

## Discipline

Everything in here is **sanitized sample data**:

- No real API keys
- No real DID
- No real chain content
- No real vault entries
- No real operator passphrase

If you spot a real secret, file a security issue immediately.

## Reference hardware

The timing baseline is captured on the slowest box Memphis officially
supports: **Intel i3-2120 (2011), 4 threads, 15 GB DDR3, no GPU, no
internet**. The sovereign-RAG stack (68 docs / 797 chunks / cross-lingual
semantic search) was proven on this box on 2026-04-19. Anything modern
(CPU since 2018, NVMe SSD, 16 GB RAM) will be 2–10× faster.

## How to use this

1. Read `01-fresh-install.md` — match your output against the example.
2. If `memphis init` (in `02-first-run.md`) prompts differ, your install
   may be on a different version — check the canonical install guide.
3. After `04-vault-setup.md`, run `memphis health --json` and compare
   against `05-health-snapshot.json` — fields should match shape (values
   will differ).
4. Use `06-timing-baseline.txt` to know if your install is "slow" vs
   "expected on slow hardware".
