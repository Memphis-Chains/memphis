# Alert Severity + Throttle Policy (Runtime Smoke)

## Scope
Applies to nightly/local runtime smoke alerts emitted by:
- `scripts/local-nightly-runtime-smoke-alert.sh`

## Severity
- Default: `critical`
- Config key: `ALERT_SEVERITY`
- Included in webhook message as `[severity]` marker.

Recommended mapping:
- `critical`: smoke failure with production impact risk.
- `warning`: degraded but non-blocking environments.

## Throttle
- Config key: `ALERT_THROTTLE_SECONDS`
- Default: `1800` (30 min)
- State file: `~/.memphis/state/mv4-nightly-smoke-last-alert-<severity>.epoch`

Behavior:
- If a failure occurs inside throttle window, alert is suppressed.
- Script still exits non-zero so systemd/job state remains visible.

## Required env
- `OLLAMA_SMOKE_ALERT_WEBHOOK` (optional but recommended)
- `ALERT_SEVERITY`
- `ALERT_THROTTLE_SECONDS`

## Operator note
Use throttle to prevent alert storms during persistent incidents while preserving failure signal in logs and service status.
