# SLO baseline

This document is the source of truth for "is Memphis healthy?" — the
thresholds every subsystem is held to, how they're measured, and the
policy for what happens when we breach.

It ties into [observability.md](./observability.md) (where the metrics
come from) and [operator-handbook.md](./operator-handbook.md) (where
operators see the headline).

## Service-level objectives

| SLO                         | Target                                          | Window        | Metric                                                                                 | Source                                          |
| --------------------------- | ----------------------------------------------- | ------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Turn latency (p95)          | ≤ 8 s                                           | rolling 5 min | `histogram_quantile(0.95, sum(rate(ask_request_duration_seconds_bucket[5m])) by (le))` | Sprint 3 cascade, measured in Sprint 10 metrics |
| Turn latency (p99)          | ≤ 30 s                                          | rolling 5 min | `histogram_quantile(0.99, ...)`                                                        | accommodates Ollama long-tail fallback          |
| `/status` latency (p95)     | ≤ 500 ms                                        | rolling 5 min | `request_duration_seconds` with `route="/v1/ops/status"`                               | Sprint 5 cross-surface payload must stay cheap  |
| Vault unlock                | ≤ 200 ms                                        | per call      | `ask_request_duration_seconds` on vault boundary                                       | Sprint 1 vault path                             |
| `chain verify`              | ≤ 30 s for 10 MB archive                        | per run       | CLI wall-clock                                                                         | Sprint 12 verifier                              |
| Error rate (5xx on `/v1/*`) | ≤ 0.1%                                          | rolling 1 h   | `sum(rate(errors_total{status_class="5xx"}[1h])) / sum(rate(requests_total[1h]))`      | Sprint 10 error counter                         |
| Provider degradation        | ≤ 10% of turns landing on tier-5 local-fallback | rolling 1 h   | custom — degradation recorded in turn telemetry                                        | Sprint 3 cascade                                |

### SLO rationale

- **8 s turn p95** reflects a realistic upper bound when the
  `anthropic → minimax` fallback engages. Ollama is the third fallback
  and is explicitly allowed to be slow (see the operator directive on
  providing answers "even if that answer would be provided in two
  weeks time") — p95 excludes the explicit-long-context Ollama path.
- **500 ms `/status`** — Sprint 5 adds cross-surface presence and
  surface-status formatting; this target pins that the extra work
  can't blow the observability budget of the dashboard.
- **200 ms vault unlock** — the cipher cycle probed in `memphis
doctor` runs in single-digit ms on warm data; 200 ms catches a cold
  cache but still pages on a locked or broken vault.
- **30 s `chain verify` for 10 MB** — Sprint 12 re-reads every block
  file and re-computes SHA-256. On the SSD test host the actual
  number is ~5 s; 30 s gives headroom for slower disks before the
  nightly CI drill starts alerting.

## Error budget

Monthly error budget = (1 - target availability) × 30 days.

| SLO                     | Target availability | Monthly budget     |
| ----------------------- | ------------------- | ------------------ |
| Turn latency (p95 ≤ 8s) | 99%                 | 7h 12m of breaches |
| `/status` (p95 ≤ 500ms) | 99.9%               | 43m                |
| 5xx rate                | 99.9%               | 43m                |

Policy: **if any SLO has burned more than 50% of its monthly budget
in the first half of the month, the next sprint pauses feature work
until the root cause is fixed.** This is the freeze policy.

## What breaches trigger

Every SLO breach fires an alert with severity matching the metric's
impact:

| Breach                                         | Severity | Channel                        |
| ---------------------------------------------- | -------- | ------------------------------ |
| Turn p95 > 8s for 10 min                       | high     | Slack + PagerDuty              |
| /status p95 > 500ms for 5 min                  | medium   | Slack                          |
| 5xx rate > 0.1% for 10 min                     | high     | Slack + PagerDuty              |
| Vault unlock > 200ms single call               | low      | Slack + `emergency.log`        |
| chain verify > 30s                             | medium   | Slack + mark in nightly report |
| Local-fallback tier hits > 10% of turns in 1 h | critical | Page (all providers are down)  |

`MEMPHIS_ALERT_DEDUPE_WINDOW_MS` (default 5 min) prevents flood — a
stuck upstream still counts as one alert per window.

See [observability.md](./observability.md) for how to wire the
webhooks.

## Measurement surface

- **Prometheus endpoint**: `/metrics` on the HTTP server, unauth for
  local scrapers; `/v1/metrics` behind auth for remote.
- **Grafana dashboard**: `docs/observability/grafana-memphis.json` —
  import once; panels already cover every metric named above.
- **CLI spot-check**: `memphis doctor` exercises the vault cipher
  cycle and reports per-component health for triage.

## What's explicitly out of scope

- **Client-perceived latency** (round-trip including network to
  Telegram/user) — the SLOs above are server-side. End-to-end is
  above our control.
- **Ollama-only runs** — when the cascade has exhausted Anthropic and
  Minimax, Ollama is deliberately allowed long. Turn latency is
  measured excluding these reach-deep cases; if you want a separate
  SLO for "offline-only availability", track `provider_name="ollama"`
  in a dedicated panel.
- **Startup time** — Memphis is a long-running daemon; cold-start
  latency is a release concern, not an SLO concern.

## Regressions

The CI quality-gate (`quality-gate` in `.github/workflows/ci.yml`)
runs the full test suite; sprint tests that guard these SLOs (e.g.
`tests/integration/backup-restore-drill.test.ts` for recovery-time
targets) fail the build if the numbers regress.

Adding a new SLO means adding a failing-regression test for it in the
same PR. No numbers without enforcement.
