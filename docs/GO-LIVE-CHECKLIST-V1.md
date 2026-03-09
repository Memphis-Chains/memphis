# GO-LIVE CHECKLIST v1

## Pre-flight
- [x] `npm ci`
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm run test`
- [x] `npm run build`
- [x] `./scripts/secret-scan.sh`

## Config safety
- [x] `NODE_ENV=production`
- [x] `MEMPHIS_API_TOKEN` set
- [x] production provider keys configured for selected default provider *(local production mode: `decentralized-llm` via local Ollama bridge on `127.0.0.1:11435`, key=`local-ollama`)*
- [x] `DATABASE_URL` points to persistent storage *(current host path: `file:/home/memphis_ai_brain_on_chain/memphis-v4/data/memphis-v4-prod.db`)*

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
