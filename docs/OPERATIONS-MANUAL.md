# Memphis v5 Operations Manual

## 1) Installation Procedures

## Prerequisites
- Node.js 20+
- npm
- Rust (stable) + Cargo
- `tar` (for backup/restore)
- Optional: Ollama (`ollama pull nomic-embed-text`)

## Standard installation
```bash
git clone https://github.com/Memphis-Chains/memphis-v5.git
cd memphis-v5
./scripts/install.sh
memphis health
```

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

---

## 3) Monitoring Setup

## Health checks
- CLI: `memphis health`
- HTTP app probe: `GET /health`
- Ops summary: `GET /v1/ops/status`
- Providers: `GET /v1/providers/health`

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

Fix:
1. set `RUST_CHAIN_ENABLED=true`
2. set `MEMPHIS_VAULT_PEPPER` (min 12 chars)
3. verify bridge path (`RUST_CHAIN_BRIDGE_PATH`)
4. rebuild: `npm run build`

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
- [ ] provider health acceptable
- [ ] no spike in 401/429/503 errors
- [ ] backup completed and checksum-valid
- [ ] security audit log reviewed for blocked exec/journal attempts
