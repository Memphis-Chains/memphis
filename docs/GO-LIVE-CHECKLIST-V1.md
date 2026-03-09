# GO-LIVE CHECKLIST v1

## Pre-flight
- [x] `npm ci`
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm run test`
- [x] `npm run build`
- [x] `./scripts/secret-scan.sh`

## Must-pass smoke
- [x] `npm run ops:quality-runtime-pack`
- [x] `npm run smoke:ollama-runtime`
- [x] vault smoke path tracked in `docs/MUST-PASS-SMOKE.md`

## Config safety
- [x] `NODE_ENV=production`
- [x] `MEMPHIS_API_TOKEN` set
- [x] production provider keys configured for selected default provider *(local production mode: `decentralized-llm` via local Ollama bridge on `127.0.0.1:11435`, key=`local-ollama`)*
- [x] `DATABASE_URL` points to persistent storage *(current host path: `file:/home/memphis_ai_brain_on_chain/memphis-v4/data/memphis-v4-prod.db`)*
- [x] DB/backup baseline reviewed (`docs/DB-BACKUP-BASELINE.md`)

### Required runtime profile (before promote)
- If `DEFAULT_PROVIDER=shared-llm`: set `SHARED_LLM_API_BASE` + `SHARED_LLM_API_KEY`.
- If `DEFAULT_PROVIDER=decentralized-llm`: set `DECENTRALIZED_LLM_API_BASE` + `DECENTRALIZED_LLM_API_KEY`.
- If running smoke with `DEFAULT_PROVIDER=local-fallback`, keep note that this is validation mode, not final production provider posture.

## Runtime checks
- [x] `GET /health` returns ok
- [x] `GET /v1/ops/status` returns health summary with color
- [x] `GET /v1/metrics` reachable with auth
- [ ] gateway `/ops/status` returns health summary *(optional: only when gateway compatibility route is enabled in deployment topology)*

## Post-deploy
- [x] confirm logs are clean (no repeated errors)
- [x] verify provider success/failure counters
- [x] create checkpoint tag

## Run notes (2026-03-09 07:50 CET)
- Runtime smoke executed on `127.0.0.1:4411` with `NODE_ENV=production` and `DEFAULT_PROVIDER=local-fallback`.
- `gateway /ops/status` returned HTTP 404 in this app runtime shape (route not exposed here).
- `production provider keys` and `DATABASE_URL` remain pending explicit production provider/database configuration in `.env.production.local`.

## Final go-live note (2026-03-09)
- Active production mode: **local Ollama path** (`decentralized-llm` via bridge `127.0.0.1:11435`, model `qwen3.5:2b`).
- Runtime guardrails active: bridge systemd service + healthcheck timer + nightly smoke + failure alerting.
- Known limits:
  - external/cloud provider path (`shared-llm`) not configured in this profile,
  - bridge path depends on local Ollama daemon availability,
  - gateway `/ops/status` remains topology-dependent (optional in current app runtime).
