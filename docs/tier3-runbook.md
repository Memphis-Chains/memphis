# Tier-3 Elevation — Operator Runbook

Tier-3 is Memphis's time-limited, passphrase-gated "full access" mode.
It is opt-in, audited, and auto-expires after **3 hours**. Use it only when
you need Memphis to do things that cross the tier-2 boundary (modify existing
files outside `~/memphis/`, run unrestricted commands, or bump the surface
`MAX_TOOL_TIER` to `3`).

This runbook covers the entire lifecycle: what tier-3 unlocks, how to grant it
on each surface, how to check status, how to revoke, what gets audited, and
what to do when something fails.

---

## What tier-3 unlocks

When a tier-3 session is active for `(surface, actorId)` Memphis merges these
into that turn's `rawEnv`:

| Env var | Value | Effect |
|---|---|---|
| `MEMPHIS_SURFACE_<SLUG>_MAX_TOOL_TIER` | `3` | Surface may call tier-3 tools |
| `MEMPHIS_AUTONOMY_MODE` | `full` | Drops `GATEWAY_EXEC_RESTRICTED_MODE` (unrestricted exec allowlist) |
| `MEMPHIS_TIER3_FS_UNRESTRICTED` | `true` | Drops the "create-new only outside sandbox" rule for fs-write / fs-ops |

Outside the sandbox (`~/memphis/`), **without** tier-3:

- `create-new`, `copy-dest`, `move-dest`, `mkdir`, `stat` — allowed
- `append`, `overwrite`, `delete` on existing paths — **denied** (AppError 403)

**With** tier-3: all of the above are allowed *except* always-blocked paths.

## What tier-3 never unlocks (always-blocked)

These are blocked at every tier, including tier-3 — no exceptions, no override:

- `.env`, `.env.*` (any depth)
- `vault-state.json`, `vault-entries.json`
- `.git/` directories
- `node_modules/` directories

Rationale: vault recoverability and source-of-truth protection. If you need to
touch `.env` or `.git/`, do it with shell tools outside Memphis.

---

## Grant a tier-3 session

The operator passphrase you set during `memphis init` is what unlocks tier-3.
Tier-3 is **per surface + per actor** — a TUI grant does not elevate Telegram.

### TUI

```
/tier 3
```

TUI prompts for the operator passphrase on stderr (hidden). On success:

```
✅ Tier 3 granted for 3h (expires 2026-04-13T16:00:00Z)
```

On failure you'll see one of:

- `❌ Invalid operator passphrase.` — retry (5 attempts / 15 min window)
- `❌ Rate limited. Try again in Ns` — too many bad attempts; wait
- `❌ Operator passphrase not configured. Run "memphis init" first.`

### Telegram

```
/tier 3 <operator-passphrase>
```

Telegram requires the passphrase inline because chats have no secure prompt.
The reply confirms the grant or denial. Treat the command message as sensitive
and delete it if the channel is shared.

### CLI

```
memphis operator elevate --surface cli
```

Prompts for the operator passphrase via hidden TTY. The session is bound to
the CLI actor (`local`).

---

## Check tier-3 status

### Any surface

```
/status
```

On TUI and Telegram, `/status` shows active tier-3 sessions, the surface they
were granted for, and how many minutes remain. Expired sessions are hidden
automatically (they are evicted on first check after the deadline and an
`tier3-expire` audit event is written).

### From the shell

```
memphis operator tier3-status
```

JSON output (operator-friendly, machine-readable):

```json
{
  "active": true,
  "sessions": [
    {
      "surface": "tui",
      "actorId": "local",
      "grantedAt": "2026-04-13T13:00:00Z",
      "expiresAt": "2026-04-13T16:00:00Z",
      "remainingMs": 10800000
    }
  ]
}
```

---

## Revoke a tier-3 session

### TUI

```
/tier 2
```

Reverts to default tier-2. Writes a `tier3-revoke` audit event.

### Telegram

```
/tier 2
```

Same behaviour. No passphrase required to revoke — anyone with access to the
surface can lock it back down.

### Kill every active session (kill-switch)

```
memphis operator tier3-revoke-all
```

Writes one `tier3-revoke` event per killed session with `reason=kill-switch`.
Use this when you think a surface is compromised.

---

## Auto-expiry

Every tier-3 session expires exactly `TIER_3_TTL_MS = 3 * 60 * 60 * 1000` (3h)
after it was granted. Expiry is checked lazily:

- On every `getActiveTier3Session()` call — if past `expiresAt`, the session
  is deleted and a `tier3-expire` audit event is written.
- On `hasAnyActiveTier3Session()` — walks all sessions and evicts any that
  are past their deadline, auditing each.

There is no background timer. A session that is granted and then never
checked will linger in memory until the next check — but its *effects* are
gated by `expiresAt`, so no privilege leak occurs. A process restart clears
all sessions unconditionally.

---

## Audit trail

All tier-3 state changes write to `MEMPHIS_SECURITY_AUDIT_LOG_PATH`
(defaults to `data/security-audit.jsonl`):

| Action | Status | Written when |
|---|---|---|
| `tier3-grant` | `allowed` | Operator passphrase accepted, session created |
| `tier3-deny` | `blocked` | `reason: 'bad-passphrase' \| 'rate-limited' \| 'not-configured'` |
| `tier3-revoke` | `allowed` | Manual revoke (reason recorded: `operator-request`, `ui-click`, `kill-switch`, ...) |
| `tier3-expire` | `allowed` | Auto-expiry on first post-deadline check |

Each event has `details: { surface, actorId, ...timestamps }`. Search with:

```
memphis audit search --action tier3- --since 2026-04-13
memphis audit search --action tier3-grant --status allowed --json
```

---

## Troubleshooting

### "Invalid operator passphrase"

You either mistyped or the passphrase was changed after init. If forgotten:

```
memphis vault recovery-unlock
```

Uses the recovery Q/A you set at `memphis init` time to reset the operator
passphrase. Does **not** require the current passphrase.

### "Operator passphrase not configured"

You haven't run `memphis init` or the operator config at
`<data-dir>/config/operator.json` has been deleted. Run:

```
memphis init
```

and set a passphrase + recovery Q/A.

### "Rate limited. Try again in Ns"

5 wrong attempts in 15 minutes triggers a window lock. Wait it out — there
is no bypass. The rate limit is keyed to the operator config salt, so it
survives across surfaces but not across a fresh `memphis init`.

### Tier-3 "active" but tool still denied

Tier-3 grants are per `(surface, actorId)`. If `/status` says you have a TUI
session but a Telegram command is still denied, that's correct — grant
explicitly on each surface.

The surface's `auditSurface` must also match — if you invoked from an
unrecognized surface label, the overlay falls back to no-op (see
`applyTier3EnvOverride` in `src/gateway/turn-runtime.ts`).

### Tier-3 session "active" but fs-permission says `create-new`-only

Check that `MEMPHIS_TIER3_FS_UNRESTRICTED=true` is actually present in the
tool's rawEnv. The overlay is applied in `turn-runtime.ts` and threaded
through the in-process tool executor via `deps.rawEnv`. If you wrote a new
tool that calls `assertFsPermission` with `tier3Active: false` regardless,
update the call site to pass `isTier3FsBypassActive(rawEnv)`.

### ".env is blocked even at tier 3"

Correct. `.env` and vault files are in `ALWAYS_BLOCKED_PATTERNS` — tier 3
does not override this. Modify those files from the shell.

---

## Manual smoke checklist (post-deploy)

Run this after any change that touches tier-3 code paths:

1. Grant on TUI — `/tier 3` with correct passphrase → green, `/status` shows
   the session.
2. Try overwriting `/tmp/test-tier3.txt` (create it first) via a tool call
   → succeeds at tier 3, fails at tier 2 after `/tier 2`.
3. Grant on Telegram with wrong passphrase — denied with `bad-passphrase`
   reason in `security-audit.jsonl`.
4. Grant, then restart Memphis — session is gone (in-memory state).
5. Grant, leave for 3h, reopen — first `/status` check writes
   `tier3-expire` event.
6. Grant on TUI, verify Telegram still at tier 2 — cross-surface isolation.
7. Hammer with 6 wrong passphrases — 6th attempt returns `rate-limited`
   with a visible retry window.
8. Revoke via `/tier 2` — `tier3-revoke` event with `reason: operator-request`.

Anything that deviates from the above → open an issue and attach the
relevant audit log lines.
