# Systemd Exit Code Runbook

## Purpose

Map MemphisOS exit codes to deterministic systemd behavior.

## Exit Code Registry

- `0` `SUCCESS`: clean shutdown.
- `1` `ERR_GENERAL`: generic failure, retry allowed.
- `101` `ERR_HARDENING`: security hardening failed (strict mode).
- `102` `ERR_CORRUPTION`: chain/snapshot irrecoverable.
- `103` `ERR_TRUST_ROOT`: trust-root/signature validation failure.

## Recommended Unit Snippet

```ini
[Service]
Type=simple
WorkingDirectory=/opt/memphis
ExecStart=/usr/bin/node /opt/memphis/dist/index.js
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=102 103
Environment=NODE_ENV=production
Environment=MEMPHIS_STRICT_MODE=true
```

## Operator Policy

1. Exit `101`:
   - Validate hardening prerequisites (`mlock`, seccomp/capabilities).
   - If recovery needed, restart once with `--safe-mode`.
2. Exit `102`:
   - Do not loop-restart.
   - Restore from verified backup.
3. Exit `103`:
   - Do not run untrusted binary/config.
   - Roll back to previously trusted release.

## Quick Diagnostics

```bash
systemctl status memphis
journalctl -u memphis -n 200 --no-pager
```
