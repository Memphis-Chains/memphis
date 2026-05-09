# Runbook

This file is a thin pointer to the actual runbook docs. Memphis has runbooks split by use case — pick the one that matches what you're doing.

## Daily use (5-minute runbook)

For the operator running Memphis day-to-day on their workstation:

→ **[`OPERATOR-5MIN-RUNBOOK.md`](OPERATOR-5MIN-RUNBOOK.md)**

Covers: starting the daemon, sending a Telegram message, checking doctor, opening the TUI, looking at the journal, restarting the runtime.

## Full operations manual

For backup/restore, systemd, monitoring, troubleshooting, performance tuning, upgrade procedures, and the daily operational checklist:

→ **[`OPERATIONS-MANUAL.md`](OPERATIONS-MANUAL.md)**

## Tier-3 escalation (destructive ops gating)

For operator-passphrase-protected destructive operations:

→ [`tier3-runbook.md`](tier3-runbook.md)

## Other dedicated runbooks

| Topic | File |
|---|---|
| Ollama bridge | [`OLLAMA-BRIDGE-RUNBOOK.md`](OLLAMA-BRIDGE-RUNBOOK.md) |
| Vault rotation + recovery | [`example-installation/04-vault-setup.md`](example-installation/04-vault-setup.md) |
| Demo readiness (Zawoja postmortem) | `memphis demo arm` / `memphis demo rehearse` / `memphis demo plan-b record` (CLI-driven, no separate runbook) |
| Deployment checklist | [`DEPLOYMENT-CHECKLIST.md`](DEPLOYMENT-CHECKLIST.md) |
| DB backup baseline | [`DB-BACKUP-BASELINE.md`](DB-BACKUP-BASELINE.md) |
| Force-flag bypass contracts | [`FORCE-FLAGS.md`](FORCE-FLAGS.md) |

## Diagnostic commands

```bash
memphis doctor                    # tier-1..6 + tier-A health summary
memphis health                    # short runtime probe
memphis service status            # systemd user service state
memphis tier status               # active operator-passphrase sessions
memphis demo status               # demo-arm state (per Zawoja runbook)
memphis audit search --limit 20   # recent security audit events
```
