# Debug Commands

Memphis exposes runtime debug tooling under `memphis debug`.

## Available subcommands

- `memphis debug trace <cmd>` — traces command execution steps
- `memphis debug profile <cmd>` — profiles command timing and bottlenecks
- `memphis debug memory` — captures memory snapshots and growth risk
- `memphis debug monitor` — short runtime monitor loop (latency + RSS)

## Common options

- `--format table|json|csv` (default: `table`)
- `--interval <ms|s>` (for monitor; default: `1000ms`)

## Examples

### Trace a command

```bash
memphis debug trace "node -v"
memphis debug trace "ls -la" --format json
```

### Profile a command

```bash
memphis debug profile "npm run build"
memphis debug profile "npm run build" --format csv
```

### Inspect memory

```bash
memphis debug memory
memphis debug memory --format json
```

### Monitor runtime

```bash
memphis debug monitor --interval 500ms
memphis debug monitor --interval 1s --format json
```

## Notes

- `trace` and `profile` require a non-empty command string.
- `monitor` emits sampled points; use JSON/CSV format for automation.
- For production incidents, pair this with `memphis health` and `/v1/ops/status` output.
