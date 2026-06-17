# Service Level Objectives (SLO)

The runtime exposes a small set of SLOs computed from local telemetry spans (`<dataDir>/telemetry/spans-YYYY-MM-DD.jsonl`). These are not external SLAs — they are operator-facing health indicators that gate "is the runtime healthy" decisions.

## Reading SLOs

```bash
# CLI / MCP / in-process — all wired to the same evaluator
memphis_slo_status                  # default 7-day window
memphis_slo_status windowDays=30    # custom window (1-90 days)
```

JSON envelope:

```json
{
  "ok": true,
  "windowDays": 7,
  "windowStart": "2026-04-22T...",
  "windowEnd": "2026-04-29T...",
  "spanFilesScanned": 7,
  "totalSamples": 1234,
  "failingSlos": [],
  "slos": [
    {
      "name": "p99_turn_latency_ms",
      "description": "...",
      "threshold": 3000,
      "thresholdUnit": "ms",
      "thresholdDirection": "below",
      "value": 1450,
      "status": "pass",
      "samples": 200
    },
    ...
  ]
}
```

`status` is one of:
- `pass` — value is on the right side of the threshold
- `fail` — value crossed the threshold; investigate
- `unavailable` — not enough samples in the window to compute (`reason` field explains why)

## Current SLOs

### p99_turn_latency_ms

p99 of `turn.dispatch` span latency over the window. Latency is read from `attrs['turn.timing_ms']` first, falling back to `durationMs`.

- **Threshold**: 3000 ms (3 seconds) by default; local operators can raise/lower it with `MEMPHIS_SLO_TURN_P99_MS` when the configured provider has a different normal latency profile.
- **Direction**: below (lower is better)
- **Why this matters**: every user turn — TUI, CLI chat, Telegram, HTTP — emits this span. p99 above 3s means the slowest 1% of operator interactions are too laggy to trust. Persistent fails point at provider degradation, embedding storms, or chain-write contention.

### confabulation_rate

Ratio of `confabulation.event` spans to `turn.dispatch` spans.

- **Threshold**: 0.001 (0.1%)
- **Direction**: below (lower is better)
- **Why this matters**: confabulation events are recorded by the rule-based detector when the bot's reply contradicts tool output, invents config keys, or claims success after a failure. Above 0.1% means the bot is degrading the operator's trust at scale.

### provider_error_rate

Ratio of `provider.completion` spans with `status=error`.

- **Threshold**: 0.01 (1%)
- **Direction**: below (lower is better)
- **Why this matters**: provider failures cascade to `tool.call` retries and turn timeouts. Above 1% means the cascade is firing often enough to surface in user-visible latency.

### tool_error_rate

Ratio of `tool.call` spans with `status=error`.

- **Threshold**: 0.05 (5%)
- **Direction**: below (lower is better)
- **Why this matters**: tools failing at >5% means either the LLM is calling the wrong tool, the tool is broken, or auth/policy is rejecting valid requests.

## When an SLO fails

1. Run `memphis_slo_status windowDays=1` to confirm the failure is fresh, not stale telemetry from days ago.
2. Inspect the offending span class:
   ```bash
   # Recent turn.dispatch with >3s timing
   grep '"name":"turn.dispatch"' ~/.memphis/telemetry/spans-$(date -u +%Y-%m-%d).jsonl | jq 'select(.attrs["turn.timing_ms"] > 3000)'
   # Recent confabulation events
   grep '"name":"confabulation.event"' ~/.memphis/telemetry/spans-$(date -u +%Y-%m-%d).jsonl
   ```
3. Check `memphis_health` for systemic issues (provider down, vault locked, chain integrity).
4. Open an incident if the fail persists across two consecutive `slo_status` calls 15 minutes apart.

## Recommended weekly cron

```bash
memphis cron add \
  --type shell \
  --cron "0 9 * * 1" \
  --name weekly-slo-report \
  --script "node bin/memphis.js mcp memphis_slo_status windowDays=7 --json | tee -a ~/.memphis/slo-history.log"
```

Runs every Monday 9 AM, appends snapshot to `slo-history.log`. Compare across weeks to spot drift before it crosses thresholds.

## Adding new SLOs

1. New SLO contributors emit spans through `recordLocalSpan({ name, attrs, durationMs, status })` in `src/infra/observability/console-exporter.ts`.
2. Add a compute function in `src/observability/slo-evaluator.ts` that reads those spans from the window and returns `SloResult`.
3. Push the new function into the `slos` array in `evaluateSlos()`.
4. Cover with a unit test in `tests/unit/slo-evaluator.test.ts`.
5. Document the new SLO in this file (threshold, direction, why it matters, how to remediate).

The tool surface (`memphis_slo_status`) does not need updating — it returns whatever `evaluateSlos()` produces.
