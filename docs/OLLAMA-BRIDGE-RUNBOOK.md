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

# optional: trigger GitHub self-hosted nightly smoke workflow
# Actions -> "ollama-runtime-smoke" -> Run workflow
```

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
