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
