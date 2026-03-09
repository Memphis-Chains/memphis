# OPERATOR 5-MIN RUNBOOK (LLM Path)

Use this when Memphis response quality drops or Ollama path seems down.

## 0) Fast status (30s)
```bash
systemctl --user status ollama-compat-bridge.service --no-pager
systemctl --user status ollama-bridge-healthcheck.timer --no-pager
curl -sf http://127.0.0.1:11435/health
```

## 1) Runtime smoke (60s)
```bash
cd /home/memphis_ai_brain_on_chain/memphis-v4
npm run smoke:ollama-runtime
```
Expected: `SMOKE_OLLAMA_BRIDGE_RUNTIME_OK`

## 2) If smoke fails (90s)
```bash
# logs
journalctl --user -u ollama-compat-bridge.service -n 80 --no-pager
journalctl --user -u ollama-bridge-healthcheck.service -n 80 --no-pager

# hard restart bridge
systemctl --user restart ollama-compat-bridge.service
sleep 2
curl -sf http://127.0.0.1:11435/health
```

## 3) Recovery drill (90s)
```bash
npm run drill:bridge-recovery
```
Expected: `DRILL_OLLAMA_BRIDGE_RECOVERY_OK`

## 4) Escalation (30s)
If still failing:
- check latest nightly smoke run in Actions,
- check open incident issue (`🚨 Nightly Ollama runtime smoke failed`),
- post a short incident note with run URL + first root cause clue.
