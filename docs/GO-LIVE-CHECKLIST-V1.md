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
- [ ] production provider keys configured for selected default provider
- [ ] `DATABASE_URL` points to persistent storage

## Runtime checks
- [x] `GET /health` returns ok
- [x] `GET /v1/ops/status` returns health summary with color
- [x] `GET /v1/metrics` reachable with auth
- [ ] gateway `/ops/status` returns health summary

## Post-deploy
- [x] confirm logs are clean (no repeated errors)
- [x] verify provider success/failure counters
- [x] create checkpoint tag

## Run notes (2026-03-09 07:50 CET)
- Runtime smoke executed on `127.0.0.1:4411` with `NODE_ENV=production` and `DEFAULT_PROVIDER=local-fallback`.
- `gateway /ops/status` returned HTTP 404 in this app runtime shape (route not exposed here).
- `production provider keys` and `DATABASE_URL` remain pending explicit production provider/database configuration in `.env.production.local`.
