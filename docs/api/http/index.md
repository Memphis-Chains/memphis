# HTTP API

## Endpoints
- `GET /health` — Service health payload and dependency checks.
- `GET /metrics` — Prometheus metrics exposition.
- `GET /v1/metrics` — JSON metrics snapshot.
- `GET /v1/providers/health` — Provider health list.
- `GET /v1/ops/status` — Operational status summary.
- `POST /v1/chat/generate` — Generate model response.
- `POST /v1/vault/init` — Initialize vault state.
- `POST /v1/vault/encrypt` — Encrypt and persist vault entry.
- `POST /v1/vault/decrypt` — Decrypt a vault entry.
- `GET /v1/vault/entries` — List stored encrypted entries (+ integrity flag).
- `GET /v1/sessions` — List generation sessions.
- `GET /v1/sessions/:sessionId/events` — List generation events for a session.

## Auth
Protected endpoints require `Authorization: Bearer $MEMPHIS_API_TOKEN` when token is configured.

## Error Codes
HTTP handlers return structured errors with code/message/requestId. See [../core/errors.md](../core/errors.md).
