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
  "sampleWindowStart": "2026-04-28T...",
  "maxAgeMs": 86400000,
  "evaluatedSamples": 1234,
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
      "samples": 200,
      "lastSampleAt": "2026-04-29T11:58:00.000Z",
      "ageMs": 120000
    },
    ...
  ]
}
```

### The recency bound (`maxAgeMs`)

An SLO describes the **current** state of the runtime, so samples older
than the recency bound do not decide pass/fail.

- Default: **24h** (`MEMPHIS_SLO_MAX_AGE_MS`, milliseconds).
- `MEMPHIS_SLO_MAX_AGE_MS=0` disables the bound and restores the
  window-average semantics (7-day request = 7-day average).
- `sampleWindowStart` is the effective start of the evaluated population:
  the requested window intersected with the bound.
- `lastSampleAt` / `ageMs` say how old the newest evidence for that SLO is.
  When a class went dark, the reason names it: `no tool.call spans in
  window - last tool.call span 3d ago`.

Why the bound exists (measured 2026-10-29): every failing SLO in the 7-day
window was decided by evidence from 2026-10-25 — one 34-minute Telegram
turn, one confabulation event, and a tool-error rate computed from
`tool.call` spans that stopped being emitted on 2026-10-26. The report said
"fail" every day for a runtime with no current tool telemetry at all.

`status` is one of:
- `pass` — value is on the right side of the threshold
- `fail` — value crossed the threshold; investigate
- `unavailable` — the report cannot judge: no samples in the evaluated
  window, or fewer than `minSamples` of them. `reason` explains which, and
  `lastSampleAt` / `ageMs` say how old the last evidence was.

`unavailable` is not a soft `fail`. A runtime with no current telemetry is
a runtime nobody measured — it must not be reported as healthy, and it must
not be reported as broken either. The autonomy gate treats only `fail` as
blocking (`src/infra/runtime/self-governance.ts`).

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

## Where the spans come from

Two surfaces write to the same JSONL sink
(`<dataDir>/telemetry/spans-YYYY-MM-DD.jsonl`), in the same record shape:

| Surface | Emitter | What it records |
| --- | --- | --- |
| TypeScript gateway (Telegram, CLI chat, HTTP) | `src/infra/observability/instrument.ts` | `turn.dispatch`, `provider.completion`, `tool.call` |
| Native Rust operator (the authoritative TUI) | `crates/memphis-operator/src/telemetry.rs` | `tool.call` |

The native surface executes tools itself, so without the Rust sink every
native tool call was invisible here — measured on 2026-10-29: `tool.call`
spans stopped on 2026-10-26, the day the operator moved to the Rust TUI.
Both sinks honour `MEMPHIS_TELEMETRY_LOCAL_SINK=false`.

## Adding new SLOs

1. New SLO contributors emit spans through `recordLocalSpan({ name, attrs, durationMs, status })` in `src/infra/observability/console-exporter.ts` — or, on the native surface, `crate::telemetry::record_span(...)` in `crates/memphis-operator/src/telemetry.rs`.
2. Add a compute function in `src/observability/slo-evaluator.ts` that reads those spans from the window and returns `SloResult`.
3. Push the new function into the `slos` array in `evaluateSlos()`.
3a. If the SLO has its own span class, add the class name to `SLO_CLASS_SPANS` so the report can say how old that evidence is.
4. Cover with a unit test in `tests/unit/slo-evaluator.test.ts`.
5. Document the new SLO in this file (threshold, direction, why it matters, how to remediate).

The tool surface (`memphis_slo_status`) does not need updating — it returns whatever `evaluateSlos()` produces.
