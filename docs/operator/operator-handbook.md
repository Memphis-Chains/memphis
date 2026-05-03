# Operator handbook

One page. Entry point for every operator task that matters, organized by
how long you've had Memphis running. Each section points to the
deep-dive doc for the details; come here first.

## Day 0 — one-liner install

From a clean Linux host:

```
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash
```

The installer prints a first-run doctor summary at the end. If anything
is red, stop and fix before moving on.

Reference: [GETTING-STARTED.md](./GETTING-STARTED.md),
[ONBOARDING-INSTALL.md](./ONBOARDING-INSTALL.md).

## Day 1 — make it yours

1. **Provision the vault pepper** — pick a 32-char random string, store
   it in `.env` as `MEMPHIS_VAULT_PEPPER` _and_ in your password
   manager. Losing the pepper means losing the vault. See
   [key-lifecycle.md](./key-lifecycle.md#0a-pepper-provisioning).
2. **Initialize the vault** with a passphrase plus a recovery Q/A:
   ```
   memphis vault init --passphrase '…' --recovery-question '…' --recovery-answer '…'
   ```
3. **Install your primary provider** — OAuth flow is preferred:
   ```
   memphis auth anthropic
   ```
   Fallback API-key path: `memphis vault add --key anthropic_api_key --value <key>`.
4. **First turn** — run `memphis chat` or point Telegram at the bot.
   The default cognitive mode is `A` (ConsciousCapture); see
   [cognitive-modes.md](./cognitive-modes.md) to pick another.

## Day 7 — hardening

- **Tier-3 elevation** — for writes that touch secrets (new vault
  entries, `.env` edits for `*_API_KEY` fields, pepper rotation), use
  `/tier 3 <passphrase>` in Telegram or `security.tier.elevate` in
  TUI. Sessions expire after 3h. Audit trail:
  `tail -f data/security-audit.jsonl`.
- **Rotate the tier-3 passphrase** at least quarterly:
  `memphis vault recovery-unlock` (from Sprint 1).
- **Review audit rotation** — check `data/security-audit.jsonl` is
  under 10 MB; Sprint 1 rotates at that ceiling with 8 archives kept.

## Day 30 — tuning

- **Cognitive mode**: `/mode A..E` in Telegram or `cognitive.mode` via
  TUI. `A` is default (short-range frames); `E` is weekly
  meta-cognitive reflection. [cognitive-modes.md](./cognitive-modes.md)
  enumerates all five.
- **Provider cascade**: the default order is
  `ollama → anthropic → minimax → local-fallback` (sovereign-AI: local
  model first, online flagship as fallback for harder turns). Override
  with `MEMPHIS_PROVIDER_CASCADE=…` in `.env` + `/config reload`. See
  the [provider registry](./API-REFERENCE.md#providers) for which
  providers support OAuth vs API-key.
- **On-the-fly config** — every hot/warm field can be changed without
  restart:
  ```
  /config show GEN_MAX_TOKENS
  /config set GEN_MAX_TOKENS=8192
  /config reload
  ```
  Tier-3 is required for secret fields. Cold fields (port, database
  URL) return 409. See [config-on-the-fly.md](./config-on-the-fly.md).
- **Rate limits** — `MEMPHIS_RATE_LIMIT_GLOBAL_MAX` and
  `MEMPHIS_RATE_LIMIT_SENSITIVE_MAX`. These are currently warm
  (swap requires restart to take effect in the running limiter); a
  follow-up makes them fully hot.

## Day 90 — disaster recovery drill

Run the drill at least quarterly. Untested restore is a prayer.

```
memphis backup                                    # create fresh backup
memphis backup list
memphis backup verify <file>
# Stop Memphis, wipe data dir, restore:
memphis backup restore <file> --yes
```

For cross-host restores (different `MEMPHIS_VAULT_PEPPER`):

```
memphis backup restore <file> --yes --pepper-restore <source-host-pepper>
```

Automated version: `npm run drill:backup-restore`.

See [disaster-recovery.md](./disaster-recovery.md) for:

- Chain corruption recovery path
- Vault-won't-decrypt diagnosis
- Archive truncation triage
- Recovery-time targets

## Observability

- **`/status`** (any surface) — returns runtime health, provider
  cascade state, active cognitive mode, cross-surface presence.
- **Prometheus** at `/metrics` on the HTTP server.
- **Grafana** — import
  `docs/observability/grafana-memphis.json` against your Prometheus
  datasource. Panels: request rate, p50/p95/p99 latency, provider
  latency, chain growth, rate-limit denials. See
  [observability.md](./observability.md).
- **Alerts** — Slack (`MEMPHIS_ALERT_SLACK_WEBHOOK`), generic
  webhook (`MEMPHIS_ALERT_WEBHOOK_URL`), PagerDuty, or OpsGenie.
  All run in parallel; dedup window is
  `MEMPHIS_ALERT_DEDUPE_WINDOW_MS` (default 5 min).

## When something goes wrong

| Symptom                                       | First check                        | Deep-dive doc                                                              |
| --------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| Vault returns `vault_decrypt_failed`          | Did `MEMPHIS_VAULT_PEPPER` change? | [disaster-recovery.md](./disaster-recovery.md#when-the-vault-wont-decrypt) |
| `chain integrity check failed: hash mismatch` | Run `memphis chain verify`         | [chain-integrity.md](./chain-integrity.md#verification)                    |
| Telegram `/status` shows provider "degraded"  | `memphis providers health`         | [API-REFERENCE.md#providers](./API-REFERENCE.md#providers)                 |
| Tier-3 denial on an expected op               | `security.tier.status` in TUI      | [key-lifecycle.md](./key-lifecycle.md)                                     |
| /metrics lacks a panel you want               | Check `/metrics` raw output first  | [observability.md](./observability.md)                                     |
| Install failed                                | Node/Rust toolchain sanity         | [TROUBLESHOOTING-DECISION-TREE.md](./TROUBLESHOOTING-DECISION-TREE.md)     |

## Surface cheat-sheet

| Surface                    | How to open                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| TUI                        | `memphis` (launches the Rust TUI against the local host daemon)                                                                        |
| Telegram                   | set `MEMPHIS_TELEGRAM_BOT_TOKEN`, add your user id to `MEMPHIS_TELEGRAM_ALLOWED_USER_IDS`, then `/start`                               |
| HTTP REST                  | `curl -H "Authorization: Bearer $MEMPHIS_API_TOKEN" http://localhost:3000/v1/ops/status`                                               |
| MCP (for Claude Code etc.) | `memphis mcp` — stdio JSON-RPC exposing `memphis_presence`, `memphis_config_*`, `memphis_fs_*`, `memphis_exec`, `memphis_health`, etc. |

Full matrix: [surface-parity.md](./surface-parity.md).

## SLO baseline

Targets we regress against in CI (see [slo-baseline.md](./slo-baseline.md)):

- Turn p95 ≤ 8s on cascade `ollama → anthropic → minimax`
- `/status` ≤ 500ms
- Vault unlock ≤ 200ms
- `chain verify` ≤ 30s for a 10 MB archive

A breach is a real incident, not a warning: page, don't log.
