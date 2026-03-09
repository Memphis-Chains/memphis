# Log Retention Policy (Bridge + Runtime)

## Scope
- `journalctl --user` logs for:
  - `ollama-compat-bridge.service`
  - `ollama-bridge-healthcheck.service`
- temporary runtime smoke logs in `/tmp` (`/tmp/mv4-*`, `/tmp/ollama-compat-bridge.log`)

## Policy
- Journal retention target: **14 days**
- Temporary smoke logs retention target: **7 days**
- Keep only operationally useful logs; avoid unbounded growth.

## Maintenance command
```bash
./scripts/runtime-log-maintenance.sh
```

## Recommended cadence
- Daily (cron/systemd timer) or after incident-heavy periods.

## Notes
- Journal vacuum is best-effort and depends on user journal permissions.
- If stricter retention is required, enforce in host-level journald config.
