# HTTP API

Generated from current server contracts and routes.

## Health / Metrics

- `GET /health` - health probe
- `GET /metrics` - Prometheus metrics
- `GET /v1/metrics` - JSON metrics
- `GET /api/status` - system status
- `GET /v1/ops/status` - operations status

## Chat

- `POST /v1/chat/generate` - chat generation
- `POST /v1/chat/completions` - OpenAI-compatible completions

## Sessions

- `GET /v1/sessions` - list sessions
- `GET /v1/sessions/:sessionId/events` - fetch session events

## Memory / Journal

- `POST /api/journal` - write to journal
- `POST /api/recall` - semantic recall memory context
- `POST /api/search` - exact phrase search over derived FTS5 memory index

## Config

- `POST /v1/config/set` - set config value
- `GET /v1/config/get` - get config value
- `GET /v1/config/list` - list all config
- `GET /v1/config/history` - config history
- `DELETE /v1/config/delete` - delete config key

## Vault

- `POST /v1/vault/init` - initialize vault
- `POST /v1/vault/encrypt` - encrypt data
- `POST /v1/vault/decrypt` - decrypt data
- `GET /v1/vault/entries` - list vault entries

## Soul

- `POST /v1/soul/replay` - replay soul memory
- `POST /v1/soul/loop-step` - soul loop step

## Admin / Dual Approval

- `POST /v1/admin/dual-approval/request` - request dual approval
- `POST /v1/admin/dual-approval/approve` - approve request
- `POST /v1/admin/dual-approval/cancel` - cancel request
- `GET /v1/admin/dual-approval/:requestId` - get request status

## Federation

- `GET /api/federation/health` - federation health
- `POST /api/federation/peers/register` - register peer
- `POST /api/federation/peers/heartbeat` - peer heartbeat
- `GET /api/federation/peers` - list peers

## Webhooks

- `POST /api/webhooks/ingest` - ingest webhook
- `GET /api/webhooks/events` - list webhook events
- `POST /api/webhooks/retry` - retry failed webhook

## Tasks

- `GET /api/tasks/status` - task status
- `GET /api/tasks/pending` - pending tasks

## Analytics

- `GET /api/analytics` - analytics snapshot

## Decision

- `POST /api/decide` - log decision
- `POST /api/model-d/proposals` - Model-D proposals

## Providers

- `GET /v1/providers/health` - provider health check

## Auth / Policies

- Bearer token policy via `src/infra/http/auth-policy.ts`
- Rate limit policy via `src/infra/http/rate-limit.ts`
