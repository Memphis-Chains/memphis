# Memphis Operations Manual

## 1) Installation Procedures

## Prerequisites

- Node.js v22+
- npm
- Rust (stable) + Cargo
- `tar` (for backup/restore)
- Optional: Ollama (`ollama pull nomic-embed-text`)

## Standard installation

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
./scripts/bootstrap.sh
memphis init
memphis health
```

`bootstrap.sh` generates secrets (API token, vault pepper), creates `.env`,
builds Memphis, initializes the agent profile, and optionally installs a
systemd user service.

`memphis init` is the canonical controlled first-run step. It handles operator
passphrase enrollment, vault setup, first-state preview, and initial chain
creation.

This source-checkout path is the canonical full-runtime operator flow for GA.
GitHub Releases and GitHub Packages publish the package artifact and CLI
distribution path, but they do not replace bootstrap for the full local runtime.

## Historical note: old auto-vault bootstrap flow

```bash
# Historical pattern kept only for old notes and recovery context
MEMPHIS_VAULT_PASSPHRASE="your-passphrase" \
MEMPHIS_VAULT_RECOVERY_QUESTION="What is your name?" \
MEMPHIS_VAULT_RECOVERY_ANSWER="operator" \
./scripts/bootstrap.sh
```

This is no longer the canonical onboarding story. Use `memphis init` after
bootstrap instead.

## Manual installation

```bash
npm install
npm run build
npm link
npm run -s cli -- doctor --json
```

## Production basics

- set `MEMPHIS_API_TOKEN`
- set `MEMPHIS_VAULT_PEPPER` (>=12 chars)
- keep `RUST_CHAIN_ENABLED=true` for full vault/embed features
- use non-root service account
- install systemd service: `memphis service install`
- set operator passphrase: `memphis operator set-passphrase`

---

## 2) Backup & Restore Workflows

Backup commands are implemented in `src/infra/cli/commands/backup.ts`.

> Important: `memphis backup` with no subcommand defaults to **create**.

## Create backup

```bash
memphis backup
# explicit form
memphis backup create
# with tag
memphis backup create --tag nightly
```

## List backups

```bash
memphis backup list
```

## Verify backup checksum

```bash
memphis backup verify <backup-file-or-id>
```

## Restore backup

```bash
memphis backup restore <backup-file-or-id> --yes
```

Restore behavior:

- verifies checksum first
- creates **pre-restore backup** automatically
- extracts to temp dir and swaps data atomically
- logs restore events into `backups/restore.log`

## Cleanup old backups

```bash
memphis backup clean --keep 7
memphis backup clean --keep 7 --dry-run
```

The built-in `scheduled-backup` job keeps seven backups tagged `scheduled`.
Its cleaner never removes manual, release, pre-repair, pre-restore, or
unclassified legacy archives.

## Built-in scheduler

`memphis init` installs the canonical scheduler jobs. Memphis is the only
control plane; do not duplicate them in system cron.

```bash
memphis schedule list
memphis schedule reconcile --dry-run
memphis schedule reconcile --apply
```

Reconcile is dry-run by default. Apply requires operator authentication,
backs up `tasks.json` and the current crontab, removes only the tagged legacy
Memphis briefing entry, preserves custom tasks, and installs the canonical
typed jobs.

---

## 2b) Systemd Service Management

Install Memphis as a systemd user service for auto-restart and session persistence:

```bash
memphis service install
memphis service status
memphis service restart
memphis service logs --latest 50
memphis service uninstall
```

The service runs `npm run dev` under a user-level systemd unit. Check status:

```bash
systemctl --user status memphis.service
journalctl --user -u memphis.service -f
```

### Runtime reset

Wipe runtime state including data directory, `.env`, and service:

```bash
memphis reset --runtime --yes
```

This reset path also removes stale local runtime debris that does not belong to
the canonical state model, including orphaned `./undefined/` chain roots and
root-level `memphis.db*` / `embed-index.json` leftovers from historical layouts.

---

## 2c) Telegram Gateway Control

The Telegram channel gateway is env-driven in `v1.0.0`; there is no separate
`memphis gateway start|stop|status` CLI control surface.

Configure via `.env`:

```dotenv
MEMPHIS_CHANNEL_GATEWAY_ENABLED=true
MEMPHIS_TELEGRAM_BOT_TOKEN=...
MEMPHIS_TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

User allowlist: set `MEMPHIS_TELEGRAM_ALLOWED_USER_IDS` to a comma-separated list of numeric Telegram user IDs. Leave empty to allow all users.

Send messages via CLI:

```bash
memphis telegram send --value "Hello from Memphis" --to 123456789
memphis telegram status
```

---

## 3) Monitoring Setup

## Health checks

- CLI: `memphis health`
- Comprehensive diagnostic: `memphis doctor` (v2.0, 25+ checks across 7 tiers + Tier A)
- HTTP app probe: `GET /health`
- Ops summary: `GET /v1/ops/status`
- Providers: `GET /v1/providers/health`

### `memphis doctor` command (v2.0)

Full system diagnostic with 7 tiers plus architecture health checks:

```
memphis doctor
memphis doctor --json
memphis doctor --fix
memphis doctor --force
memphis doctor --deep
```

**Tiers:**

| Tier | Name                | Scope                                                                                                                                                                                |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Core Infrastructure | Env config, embeddings index, directory structure                                                                                                                                    |
| 2    | Provider Health     | GLM, Codex 5.3, Ollama connectivity and latency                                                                                                                                      |
| 3    | Performance         | Query latency, embed search latency, memory RSS, disk usage                                                                                                                          |
| 4    | Security            | Vault encryption, 2FA (Q&A), DID, pepper strength, queue resume policy, alert transport config                                                                                       |
| 5    | State Health        | Orphan files, stale locks, backup age, daemon status                                                                                                                                 |
| 6    | Integration         | External plugin, MCP server, multi-agent sync, managed app catalog                                                                                                                   |
| A    | Architecture Health | Provider cooldown/fallback, hybrid recall contract, experimental fallback module status, SQLite connection count, SyncManager atomicity, dead code, version drift, type completeness |

**Auto-repair flags:**

- `--fix`: Create missing directories, adjust permissions, remove stale lock files
- `--force`: Rebuild chain indexes, reset embeddings index
- `--deep`: Run shell/runtime probe and write-probe checks

**Tier 4 security checks** (run `memphis doctor` to audit):

- Pepper strength: strong = 32+ chars with uppercase, lowercase, digit
- Vault encryption: no plaintext artifacts in vault dir
- 2FA: recovery Q&A present
- DID: identity file exists
- Alert transport: PagerDuty/OpsGenie key format validation

### Experimental fallback module

`src/resilience/*` remains internal degraded-mode scaffolding and is not part of
the supported `v1.0.0` operator recall contract.

Canonical recall for operators is:

- `memphis_recall` for semantic “what do I know about X?” queries
- `memphis_search` for exact “where is X mentioned?” queries

The in-memory cache under `src/resilience/cache.ts` remains a local
experimental buffer only and must not be treated as a durable or operator-facing
search guarantee.

Monitor degraded mode via SearchCascade health check (Tier A, `ta2`).

## Prometheus

Enable and scrape:

- `GET /metrics` (Prometheus format)

Sample scrape config:

```yaml
scrape_configs:
  - job_name: memphis
    static_configs:
      - targets: ['127.0.0.1:3000']
    metrics_path: /metrics
```

## Logs and audit

- app logs via logger config (`LOG_LEVEL`, format)
- security audit log: `data/security-audit.jsonl` (default)

Recommended:

- rotate logs daily
- alert on repeated `UNAUTHORIZED`, `PROVIDER_RATE_LIMIT`, and vault failures

---

## 4) Troubleshooting Guide

## Issue: 401 Unauthorized

Symptoms:

- API returns `UNAUTHORIZED`

Fix:

1. verify `MEMPHIS_API_TOKEN` is set in server env
2. send header: `Authorization: Bearer <token>`
3. confirm no trailing spaces/newlines

## Issue: vault init/encrypt/decrypt returns 503

Symptoms:

- `vault bridge unavailable`
- `MEMPHIS_VAULT_PEPPER missing`
- `pepper too short` (pepper is set but under 12 characters)

Fix:

1. set `RUST_CHAIN_ENABLED=true`
2. set `MEMPHIS_VAULT_PEPPER` (min 12 chars, recommended 32+)
3. verify bridge path (`RUST_CHAIN_BRIDGE_PATH`)
4. rebuild: `npm run build`

## Issue: Memphis doctor shows failures

Run `memphis doctor` to identify which tier is failing:

```bash
# View all checks in JSON format
memphis doctor --json

# Auto-repair Tier 1–5 issues (permissions, stale locks)
memphis doctor --fix

# Force-rebuild chain indexes and embeddings
memphis doctor --force

# Run deep architecture checks
memphis doctor --deep
```

Required checks (Tier 1, Tier 4): must pass for a healthy system. Optional checks (Tiers 2, 3, 5, 6, A) provide guidance.

### Doctor warns that need operator action (not Memphis bugs)

Closure sprint Z.2.2 (2026-05-09) downgraded several setup-related warns to non-required because they reflect operator setup state, not Memphis defects. Each has a clear next step:

#### `t4-2fa: recovery Q&A not configured`

Configure recovery Q&A so you can recover the operator passphrase if you ever lose it. **One-time action**:

```bash
# During fresh init:
memphis init --non-interactive \
  --operator-passphrase '<pass>' \
  --recovery-question 'My first dog name?' \
  --recovery-answer '<answer>'

# Already initialized? Use:
memphis operator set-passphrase \
  --recovery-question 'My first dog name?' \
  --recovery-answer '<answer>'
```

#### `t4-pepper-strength: weak (N chars)`

The vault pepper is short. Strong peppers are ≥32 chars + mixed-case + digits. Memphis has a one-shot generator that mints a 40-char pepper (`memphis-<32 hex>`, 128 bits entropy). **One-time action**:

```bash
# Mint + rotate atomically (PR #549):
memphis vault pepper-rotate --confirm --generate

# Banner shows the new pepper ONCE on stderr — copy it OFF-HOST
# (password manager / USB) BEFORE the 5-second pause completes.
# Lose it without backup = vault unrecoverable.
```

After rotation, the doctor warn clears on next run.

#### `t4-alert-transport-config: no external alert transport configured`

Memphis can page on doctor failures via PagerDuty or Opsgenie. **Optional**:

```bash
# Set in .env, then memphis service restart:
MEMPHIS_ALERT_PAGERDUTY_ROUTING_KEY=<routing-key>
# OR
MEMPHIS_ALERT_OPSGENIE_API_KEY=<api-key>
```

If you don't run paged ops, ignore this warn — operator's daily-use setup typically watches `memphis doctor` output directly without external alerts.

#### `t6-cron-tasks: N failing task(s)`

Memphis surfaces failing scheduled tasks so they don't rot silently. The fix depends on the task — read the log first:

```bash
ls /home/memphis/.memphis/config/scheduler/logs/
cat /home/memphis/.memphis/config/scheduler/logs/<taskId>.log
```

If a custom task is no longer needed, use `memphis schedule remove --id
<taskId>`. Canonical tasks should be restored with `memphis schedule
reconcile --dry-run`, reviewed, and then applied.

## Issue: metrics endpoint returns 404

- Metrics endpoint disabled by env/runtime config.
- use `/v1/metrics` for JSON snapshot regardless.

## Issue: provider failures or timeouts

1. check `/v1/providers/health`
2. verify provider keys/base URLs
3. switch to `provider=auto` for fallback
4. inspect generation `trace.attempts`

## Issue: rate limit exceeded (429)

- throttle client
- batch calls
- retry after `retryAfterMs`

## Issue: sync pull/push fails

1. validate peer DID and endpoint format
2. verify network reachability
3. inspect agent status (`online/offline`)

---

## 5) Performance Tuning

See dedicated guide: [`PERFORMANCE-TUNING.md`](./PERFORMANCE-TUNING.md).

---

## 6) Upgrade Procedures

## Safe upgrade playbook

1. **Pre-check**
   ```bash
   memphis health
   npm run -s cli -- doctor --json
   # Run auto-repair for any Tier 1-5 issues before upgrading
   npm run -s cli -- doctor --fix --force
   ```
2. **Backup**
   ```bash
   memphis backup create --tag pre-upgrade
   ```
3. **Update code**
   ```bash
   git fetch --all
   git pull --ff-only
   npm install
   npm run build
   ```
4. **Post-upgrade checks**
   ```bash
   memphis health
   npm test
   npm run -s cli -- doctor --json
   # Verify Tier 4 (security) checks pass
   npm run -s cli -- doctor --json | jq '.checks[] | select(.tier == 4 and .level != "pass")'
   ```
5. **Smoke API checks**
   - `/health`
   - `/v1/providers/health`
   - `/v1/ops/status`

## Rollback

- if regression detected:
  ```bash
  memphis backup restore <pre-upgrade-backup> --yes
  ```

---

## 7) Operational Checklist (Daily)

- [ ] `/health` returns healthy
- [ ] `memphis doctor` has no required failures (Tier 1, Tier 4 checks pass)
- [ ] provider health acceptable
- [ ] no spike in 401/429/503 errors
- [ ] backup completed and checksum-valid
- [ ] security audit log reviewed for blocked exec/journal attempts
