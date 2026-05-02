# Self-restart

Memphis can restart itself from any operator surface. The directive
that prompted this: _"Memphis Agent should be able to restart himself,
both for TUI, telegram and elsewhere."_

The restart engine lives in `src/infra/runtime/self-restart.ts`. Every
surface (Telegram, TUI host, HTTP, MCP, CLI) is a thin wrapper around
the engine — tier-3 gate, supervisor detection, audit, drain, PULSE,
exit all happen in one place.

## How to restart

| Surface  | Command                                                     |
| -------- | ----------------------------------------------------------- |
| Telegram | `/restart [reason]` (after `/tier 3 <passphrase>`)          |
| TUI host | capability `system.restart` (Rust TUI keybinding maps here) |
| HTTP     | `POST /v1/ops/restart` with optional `{reason}` body        |
| MCP      | tool `memphis_restart` with `{reason, actor_id}`            |
| CLI      | `memphis restart [reason]`                                  |

All surfaces require an active **tier-3 session**. Self-restart is
destructive — it interrupts in-flight turns — so it sits behind the
same passphrase gate as fs-overwrite and freeform-exec.

## What happens, step by step

1. **Tier-3 check** — `getActiveTier3Session(surface, actorId)`. No
   session ⇒ refuse with `not-elevated`; audited as `blocked`.
2. **Supervisor detection** — checks `NOTIFY_SOCKET`, `INVOCATION_ID`,
   `pm_id`/`PM2_HOME`, and the presence of the Memphis systemd unit
   file. If none match and `MEMPHIS_RESTART_ALLOW_SUICIDE` is not
   `true`, refuses with `no-supervisor`; audited as `blocked`.
3. **Audit** — `system.restart.requested` event with surface, actor,
   reason, supervisor, drain timeout.
4. **Drain** — every turn that registered an `AbortController` via
   `registerTurnController()` gets `controller.abort()`. The engine
   waits up to `MEMPHIS_RESTART_DRAIN_TIMEOUT_MS` (default 10 s) for
   the controller set to empty.
5. **Final PULSE** — writes a heartbeat entry with
   `detail=restart surface=… actor=… supervisor=…` so the PULSE log
   shows a clean restart seam rather than a crash-shaped gap.
6. **Exit** — `process.exit(0)` on the next event-loop tick. The
   surface adapter has a chance to send the JSON outcome back to the
   operator before the process dies.

## Configuration

| Env                                | Default | Tier (Sprint 6) | What                                                                                                      |
| ---------------------------------- | ------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| `MEMPHIS_RESTART_DRAIN_TIMEOUT_MS` | `10000` | `hot`           | How long to wait for in-flight turns before exiting. `0` skips the drain.                                 |
| `MEMPHIS_RESTART_ALLOW_SUICIDE`    | `false` | `warm`          | When `true`, allows `process.exit(0)` even without a detected supervisor. Operator must manually restart. See [FORCE-FLAGS.md](./FORCE-FLAGS.md#memphis_restart_allow_suicide) for the full bypass contract. |

`hot` means change with `/config set MEMPHIS_RESTART_DRAIN_TIMEOUT_MS=20000` →
`/config reload` and the very next restart honors the new ceiling.

## Supervisor requirements

The engine refuses to exit when no supervisor is detected because
`process.exit(0)` from a supervised process is harmless (systemd
brings it back instantly), while the same call from `npm run dev`
leaves the agent dead.

Detected supervisors:

- **systemd** — `NOTIFY_SOCKET` or `INVOCATION_ID` in env.
- **memphis-service** — the Memphis bootstrap installer lays down a
  systemd unit at `/etc/systemd/system/memphis.service` (or
  `/lib/systemd/system/memphis.service`).
- **PM2** — `pm_id` or `PM2_HOME` in env.

For local dev (`npm run dev`, direct `node …`), set
`MEMPHIS_RESTART_ALLOW_SUICIDE=true` to opt into the suicide path.
You'll need to manually restart afterwards. Useful when validating
the drain + audit + PULSE flow without a real supervisor.

## Audit trail

Every restart attempt — successful or refused — writes to
`data/security-audit.jsonl` via `writeSecurityAudit`:

```jsonc
{
  "ts": "2026-04-13T22:30:00.000Z",
  "action": "system.restart.requested",
  "status": "allowed" | "blocked",
  "details": {
    "surface": "telegram",
    "actor": "999",
    "reason": "config drift suspected",
    "supervisor": "systemd",
    "drainTimeoutMs": 10000,
    // when blocked:
    "blockedBy": "no-tier3-session" | "no-supervisor"
  }
}
```

## In-flight turn drain

Turn-runtime modules (or any long-running operation) opt into the
drain by registering an `AbortController` with the restart engine:

```ts
import { registerTurnController, unregisterTurnController } from '../infra/runtime/self-restart.js';

const controller = new AbortController();
registerTurnController(controller);
try {
  await runWithSignal(controller.signal);
} finally {
  unregisterTurnController(controller);
}
```

When a restart fires, every registered controller's `abort()` is
called with an `AppError('VALIDATION_ERROR', 'restart draining
in-flight turn', 503)`. The engine then waits for `unregisterTurnController`
calls to drain the set, bounded by the timeout. Any holdouts after
the timeout get exited under regardless — drain is best-effort.

## What this is not

- **Not a graceful drain across federated peers.** Single-process
  scope. If you run multiple Memphis agents behind a load balancer,
  restart each individually.
- **Not a config reapply.** Restart picks up `.env` changes on boot
  the same way every other process does. For mid-flight config
  updates without exit, use `/config set` + `/config reload`
  (Sprint 6 / provider hot-swap PR #94).
- **Not a Rust-side restart.** The Rust TUI client (`memphis tui`)
  reconnects to the JSON-RPC host after the host process restarts;
  it doesn't itself exit.
