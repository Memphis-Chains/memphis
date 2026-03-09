# OLLAMA Bridge Runbook (qwen3.5:2b)

## Service mode
Bridge is managed as a **user systemd service**:
- unit: `~/.config/systemd/user/ollama-compat-bridge.service`
- source template: `deploy/systemd/ollama-compat-bridge.service`

## Commands
```bash
# status
systemctl --user status ollama-compat-bridge.service

# start / stop / restart
systemctl --user start ollama-compat-bridge.service
systemctl --user stop ollama-compat-bridge.service
systemctl --user restart ollama-compat-bridge.service

# logs
journalctl --user -u ollama-compat-bridge.service -n 100 --no-pager
journalctl --user -u ollama-compat-bridge.service -f

# health
curl -sf http://127.0.0.1:11435/health

# full runtime smoke (bridge + memphis-v4 + generate)
npm run smoke:ollama-runtime

# recovery drill (stop bridge -> auto-recovery -> smoke)
npm run drill:bridge-recovery

# vault recovery drill (degraded bridge path -> deterministic runtime recovery)
MEMPHIS_VAULT_PEPPER='<12+ chars>' npm run drill:vault-recovery

# runtime log maintenance
npm run ops:log-maintenance
npm run ops:log-maintenance:json

# local nightly smoke + alert
./scripts/local-nightly-runtime-smoke-alert.sh
```

## Local nightly automation (recommended for public repo)
Use local user-systemd timer instead of public-repo self-hosted Actions.

Setup:
```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/mv4-local-nightly-smoke.service ~/.config/systemd/user/
cp deploy/systemd/mv4-local-nightly-smoke.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mv4-local-nightly-smoke.timer
```

Status/logs:
```bash
systemctl --user status mv4-local-nightly-smoke.timer
journalctl --user -u mv4-local-nightly-smoke.service -n 80 --no-pager
```

## Optional webhook alert setup (local env)
Set in `.env.production.local`:
- `OLLAMA_SMOKE_ALERT_WEBHOOK=<your incoming webhook URL>`
- `ALERT_SEVERITY=critical|warning`
- `ALERT_THROTTLE_SECONDS=1800`

Policy reference: `docs/ALERT-SEVERITY-THROTTLE-POLICY.md`

## Health monitor + auto-recovery (user systemd)
Files:
- `deploy/systemd/ollama-bridge-healthcheck.service`
- `deploy/systemd/ollama-bridge-healthcheck.timer`
- `scripts/ollama-bridge-healthcheck.sh`

Setup:
```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/ollama-bridge-healthcheck.service ~/.config/systemd/user/
cp deploy/systemd/ollama-bridge-healthcheck.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ollama-bridge-healthcheck.timer
```

Status/logs:
```bash
systemctl --user status ollama-bridge-healthcheck.timer
journalctl --user -u ollama-bridge-healthcheck.service -n 50 --no-pager
```

Behavior:
- checks `http://127.0.0.1:11435/health`
- tracks fail-count in `~/.memphis/state/ollama-bridge-health-fail-count`
- after 3 consecutive failures, auto-restarts `ollama-compat-bridge.service`

## Troubleshooting
- If service exits with `EADDRINUSE`, port 11435 is occupied.
  - kill port owner: `lsof -ti :11435 | xargs -r kill -9`
  - then restart service.
- Ensure Ollama daemon is reachable at `http://127.0.0.1:11434`.

## Current runtime contract
- Bridge endpoint for memphis-v4: `http://127.0.0.1:11435`
- API key expected by bridge: `local-ollama`
- Default model: `qwen3.5:2b`
