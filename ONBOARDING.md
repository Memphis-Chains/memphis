# Memphis — Onboarding

Welcome. Memphis is a sovereign cognitive runtime that lives on your hardware. This page is the canonical 5-minute first-run pointer.

## First time? Read this first

The single fastest path from zero to running operator:

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash -s -- --with-init
```

This installs Node 22, Rust stable, Ollama, clones the repo, builds everything, links the `memphis` CLI globally, and chains directly into `memphis init` (vault passphrase, identity, provider enrollment). At the end you have a running operator on `localhost`.

## Already cloned the repo?

Skip the curl step:

```bash
cd memphis
./scripts/bootstrap.sh
memphis init
memphis health
```

Successful initialization installs the canonical Memphis scheduler set. It
does not add system-cron entries. The operator briefing runs at 09:00
`Europe/Warsaw`; Telegram delivery is safely skipped and audited until a
recipient is configured.

```bash
memphis schedule list
memphis schedule reconcile --dry-run
```

## Where to go next

| You want to                                                                              | Read                                                                                                           |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Daily AI assistant setup** (voice + vision + Telegram + Anthropic — wszystko one-stop) | [`docs/operator/DAILY-ASSISTANT-SETUP.md`](docs/operator/DAILY-ASSISTANT-SETUP.md)                             |
| **Install fresh** (full walkthrough)                                                     | [`docs/operator/INSTALLATION.md`](docs/operator/INSTALLATION.md)                                               |
| Install fresh in **English**                                                             | [`docs/operator/install.en.md`](docs/operator/install.en.md)                                                   |
| Install fresh in **Polish**                                                              | [`docs/operator/install.pl.md`](docs/operator/install.pl.md)                                                   |
| **Daily-use 5-minute runbook**                                                           | [`docs/operator/OPERATOR-5MIN-RUNBOOK.md`](docs/operator/OPERATOR-5MIN-RUNBOOK.md)                             |
| **Full operations manual** (backup, restore, troubleshooting)                            | [`docs/operator/OPERATIONS-MANUAL.md`](docs/operator/OPERATIONS-MANUAL.md)                                     |
| **All CLI commands**                                                                     | [`docs/operator/CLI-REFERENCE.md`](docs/operator/CLI-REFERENCE.md)                                             |
| **Configuration profiles**                                                               | [`docs/operator/CONFIG-PROFILES.md`](docs/operator/CONFIG-PROFILES.md)                                         |
| **Vault rotation + recovery**                                                            | [`docs/operator/example-installation/04-vault-setup.md`](docs/operator/example-installation/04-vault-setup.md) |
| **Telegram setup**                                                                       | [`docs/operator/GUIDE-FIRST-BOOTSTRAP.md`](docs/operator/GUIDE-FIRST-BOOTSTRAP.md)                             |
| Demo readiness (per Zawoja postmortem)                                                   | `memphis demo arm`, then `memphis demo rehearse`, then `memphis demo plan-b record`                            |

## What runs locally vs what doesn't

- **Local-only**: vault, journal/decisions/case chains, embeddings index, soul memory, scheduler, doctor, audit log, scheduled-task state, demo state. All live in `~/.memphis/` (Linux/macOS).
- **Optional cloud (only if you opt in)**: provider LLM calls (OpenAI / Anthropic / GLM / DeepSeek / Codex / etc.). Memphis does not phone home for telemetry — `MEMPHIS_TELEMETRY=off` is the default.

## When something looks wrong

Always run `memphis doctor` first. It returns `ok: true` when daily-use is healthy; warns are documented and actionable. If `ok: false`, the report tells you which check failed and how to fix it. See [`docs/operator/OPERATIONS-MANUAL.md`](docs/operator/OPERATIONS-MANUAL.md) section "Doctor warns that need operator action".
