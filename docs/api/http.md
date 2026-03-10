# HTTP API

Generated from current server contracts and routes.

## Endpoints
- `GET /health` - health probe
- `GET /metrics` - Prometheus metrics
- `POST /chat` - chat completion endpoint
- `POST /ask` - ask completion endpoint
- `POST /v1/sessions` - create session
- `GET /v1/sessions/:id` - fetch session
- `POST /v1/sessions/:id/recall` - recall session context
- `POST /v1/vault/init` - initialize vault
- `POST /v1/vault/encrypt` - encrypt data
- `POST /v1/vault/decrypt` - decrypt data

## Auth / Policies
- Bearer token policy via `src/infra/http/auth-policy.ts`
- Rate limit policy via `src/infra/http/rate-limit.ts`

