# Observability

Sprint 10 added three things:

1. **Request-id propagation** at the HTTP boundary so every log line
   produced during one request or turn can be correlated across layers.
2. **Grafana dashboard template** that reads the existing `/metrics`
   Prometheus endpoint — operators import once and see request rate,
   latency percentiles, rate-limit hits, chain growth, and more.
3. **Alert fan-out** to Slack and generic webhooks on top of the
   existing PagerDuty + OpsGenie transports. Alerts now reach every
   configured channel in parallel.

OpenTelemetry SDK integration (distributed tracing) is _not_ in this
sprint — the request-id plumbing lays the substrate so OTel can overlay
later without refactoring callers.

## Contextual logger

`src/infra/logging/contextual.ts` exports `createContextualLogger()`
and `withContext()` — wrappers around Pino `child()` that carry the
well-known observability fields:

```ts
const log = createContextualLogger({
  requestId, // uuid per HTTP request
  surface, // 'http' | 'tui' | 'telegram' | 'http:worker' | ...
  actorId, // telegram chat id / operator did / ip
  turnId, // uuid per gateway turn (Sprint 11 frame id)
  route, // normalized URL path
});
log.info({ event: 'turn.start' }, 'processing turn');
```

Undefined / null / empty values are stripped so log lines stay compact.

## HTTP boundary

`src/infra/http/server.ts` — the `onRequest` hook now stamps a child
logger onto `request.log` and keeps setting the `x-request-id` response
header (unchanged). Downstream code that wants structured fields should
read `request.log` instead of importing a new logger; that way
`requestId` propagates for free.

## Grafana dashboard

`docs/observability/grafana-memphis.json` — import into Grafana via
Dashboards → Import → Upload JSON. The dashboard points at the default
Prometheus datasource and reads:

- `requests_total`, `errors_total` — request volume and error rate
- `request_duration_seconds_bucket` — histogram for p50/p95/p99
- `ask_request_duration_seconds_*`, `ask_requests_total` — provider
  latency and volume
- `queue_overload_total`, `safe_mode_denial_route_total` — back-pressure
  and policy rejections
- `dual_approval_transition_state_total` — Model D approval flow
- `chain_blocks_total`, `chain_size_bytes` — chain growth
- `embed_cache_hits_total` / `embed_cache_misses_total` — cache health
- `model_d_proposals_by_vote_total` — voting outcomes
- `schedule_jobs_created_total` / `schedule_jobs_completed_total` —
  scheduler throughput

The panels assume the Prometheus scrape target is the Memphis
`/metrics` endpoint. Protect `/v1/metrics` behind auth as before; the
unauthenticated `/metrics` endpoint stays open for local scrapers.

## Alert routing

`src/infra/logging/alert-transport.ts` — new transports:

| Env                           | Behavior                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `MEMPHIS_ALERT_SLACK_WEBHOOK` | Posts a formatted `{text}` payload with severity emoji + detail bullets to a Slack incoming webhook.                  |
| `MEMPHIS_ALERT_WEBHOOK_URL`   | Posts a normalized JSON payload `{id, severity, message, source, timestamp, details}` to an arbitrary HTTPS endpoint. |

All configured transports receive every alert **in parallel** — the
sender succeeds if at least one delivery worked, so a down Slack
webhook doesn't knock out PagerDuty. The alert is considered failed
(and surfaces via the emergency-log fallback) only when every
transport returns non-OK.

`AlertEmitter` still dedupes identical alerts within
`ALERT_THROTTLE_SECONDS` (already in `.env.example`, default 1800)
before they reach the transports, so a stuck upstream doesn't flood
Slack.

## What's deliberately not here

- **OpenTelemetry SDK** — adding the `@opentelemetry/sdk-node` runtime
  is a substantial change and deserves its own sprint. Sprint 10 sets
  up structured fields so a later OTel overlay can reuse them.
- **Log aggregation shipper** — no fluentbit/vector config; operators
  wire their own pipe against the local Pino JSON stream.
- **Escalation** — the transports fire; they don't escalate on
  unacknowledged alerts. Add PagerDuty escalation policies in the
  PagerDuty UI, not here.

## Tests

- `tests/unit/contextual-logger.test.ts` — child bindings, undefined
  stripping, field extension via `withContext`.
- `tests/unit/alert-transport-slack.test.ts` — Slack payload shape,
  generic webhook payload shape, fan-out semantics (one fail + one
  succeed → ok; all fail → throw).
