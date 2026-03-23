# Safe Mode Runbook

## Purpose

Use `--safe-mode` for forensic recovery when normal runtime protections or state are degraded.

Safe mode is **read-focused** and blocks agent execution.

## Allowed Operations

- Vault unlock / inspect
- Chain read / query
- Config read
- Health/doctor/status checks

## Denied Operations

- Agent spawn
- Tool execution
- Task scheduling
- General network egress (except configured read-only RPC probes)

## Start Procedure

```bash
memphis --safe-mode
```

For production service wrappers, pass the flag in `ExecStart`.

## Verification Checklist

1. `GET /health` responds.
2. `GET /v1/ops/status` shows service up.
3. `POST /v1/chat/generate` returns `403 PERMISSION_DENIED`.
4. Any runner spawn path is blocked.

## Recovery Flow

1. Start in safe mode.
2. Inspect queue/chain/vault status.
3. Correct root cause (config, trust root, storage, permissions).
4. Stop safe mode and restart normal mode.
5. Confirm queue resume policy behavior via `queue.resume.startup` audit event (`redispatch` is forced to `keep` in safe mode).

## Escalation

If safe-mode startup itself fails:

- Check stderr/syslog/emergency log.
- If strict-mode hardening fails: expect exit code `101`.
- If corruption is unrecoverable: exit code `102` and restore from backup.
- If trust-root validation fails: exit code `103`.

## Exit Code Reference

| Code | Constant         | Meaning                         | systemd behavior                              |
| ---- | ---------------- | ------------------------------- | --------------------------------------------- |
| 0    | `SUCCESS`        | Clean shutdown                  | —                                             |
| 1    | `ERR_GENERAL`    | Generic failure                 | Restart (on-failure)                          |
| 101  | `ERR_HARDENING`  | Security hardening check failed | **No restart** — manual intervention required |
| 102  | `ERR_CORRUPTION` | Unrecoverable data corruption   | **No restart** — restore from backup          |
| 103  | `ERR_TRUST_ROOT` | Trust root validation failed    | **No restart** — investigate key compromise   |

Defined in `src/infra/runtime/exit-codes.ts`.

## systemd Integration

The Memphis user service unit sets `RestartPreventExitStatus=101 102 103` so that
systemd does **not** restart the daemon when it exits with a hardening, corruption, or
trust-root failure. These conditions require operator investigation before the runtime
should be restarted.

To install/update the service unit:

```bash
memphis service install    # writes unit + enables + starts
memphis service status     # verify active state
```

To enter safe mode via systemd, override `ExecStart`:

```bash
systemctl --user stop memphis.service
MEMPHIS_SAFE_MODE=true memphis serve    # manual safe-mode session
```
