# CLI + TUI Latency Benchmark

Use this benchmark to track two operator-facing latencies over time:

- CLI cold startup (`memphis --help`)
- TUI command refresh round-trip (`/help`, `/obs`, screen switches)

## Run

```bash
npm run -s bench:cli-tui
npm run -s bench:cli-tui:gate
```

## Output

Reports are written to:

- `data/cli-tui-latency-benchmark-reports/latest.json`
- `data/cli-tui-latency-benchmark-reports/latest.md`

The JSON report includes:

- raw samples
- `min`, `avg`, `p50`, `p95`, `p99`, `max`
- number of TUI sessions and commands per session

## Optional tuning

```bash
BENCH_CLI_STARTUP_SAMPLES=20 \
BENCH_CLI_STARTUP_WARMUPS=3 \
BENCH_TUI_REFRESH_SESSIONS=5 \
npm run -s bench:cli-tui
```

## Release SLO targets (set on 2026-03-12)

Baseline from `data/cli-tui-latency-benchmark-reports/latest.json`:

- CLI startup p95: `335.07ms`
- CLI startup p99: `335.07ms`
- TUI refresh p95: `2.64ms`
- TUI refresh p99: `2.64ms`

Release gates:

- CLI startup p95 <= `500ms`
- CLI startup p99 <= `700ms`
- TUI refresh p95 <= `10ms`
- TUI refresh p99 <= `15ms`

The gate command reads `latest.json` and fails when limits are exceeded:

```bash
npm run -s bench:cli-tui:gate
```

Override limits when needed:

```bash
CLI_TUI_SLO_MAX_CLI_P95_MS=550 \
CLI_TUI_SLO_MAX_CLI_P99_MS=750 \
CLI_TUI_SLO_MAX_TUI_P95_MS=12 \
CLI_TUI_SLO_MAX_TUI_P99_MS=18 \
npm run -s bench:cli-tui:gate
```

## Notes

- Benchmarks run against `dist/infra/cli/index.js` when available.
- If `dist` is missing, the script falls back to `src/infra/cli/index.ts`.
- Keep this benchmark deterministic: avoid network-dependent commands in the TUI command list.
