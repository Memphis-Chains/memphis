# Memphis — Tier-3 Surface Audit — 2026-05-08

**Spec for Phase 4.2** (`v1.9.2` — tier hardening).

This doc maps the tier-3 elevation lifecycle across surfaces (CLI, TUI, HTTP, MCP, Telegram), confirms what's wired, and identifies the **2 gaps** Phase 4.2 will close.

---

## §1. Lifecycle (current state — Sprint ν is FULLY WIRED)

The tier-3 grant lifecycle was completed in commit `262e45c4` (Sprint ν, 2026-05-04). All surfaces participate.

### Grant flow

1. **Operator request** — any of:
   - CLI: `memphis tier elevate --tier 3 --passphrase <pw>` → `src/infra/cli/handlers/tier.handler.ts`
   - TUI: `/tier 3 <passphrase>` → `src/infra/tui-host/commands.ts:162` (`security.tier.elevate`)
   - HTTP: `POST /v1/ops/tier3/elevate` → `src/infra/http/server.ts:698` (auth-policy.ts:14-15)
   - Telegram: bot command (allowlist-gated)

2. **Validation** — `src/security/tier3-session.ts:183+`:
   - Verify operator passphrase
   - Mint session: `{ actorId, surface, tier: 3, grantedAt, expiresAt: grantedAt + 3h, sessionId }`
   - Audit: `tier3-grant` event with full session metadata
   - Schedule lifecycle timers (warning at -5min, expire at deadline)

3. **Active period** — 3 hours (180 min) default TTL:
   - Operations on tier-3-gated routes succeed silently
   - No re-auth required for the duration
   - Session state cached in memory + persisted (audit log + on-disk session list)

4. **Warning** — 5 minutes before expiry:
   - Active surface notification per active session
   - CLI: `stderr` warning line
   - TUI: status panel banner
   - HTTP: response header `X-Memphis-Tier3-Expiring-In: 300s`
   - Telegram: bot message to operator

5. **Expiry** — at deadline:
   - Session removed from cache
   - Audit: `tier3-expire` event
   - Next tier-3 op re-prompts for elevation

6. **Manual revoke** — `memphis tier revoke [--session-id <id>]`:
   - Audit: `tier3-revoke` event with reason
   - All surfaces refreshed

### Surface-specific notes

| Surface | Active session view | Lifecycle integration |
|---|---|---|
| CLI | `memphis tier status` (works, queries `/v1/ops/tier3/sessions`) | ✅ Full |
| TUI | `/status` shows current tier (returns 2 or 3 based on session) at `tui-host/commands.ts:87-91` | ✅ Full |
| HTTP | `GET /v1/ops/tier3/sessions` (separate endpoint, returns full session list) | ✅ Full |
| MCP | `memphis_self_describe` reads tier3 sessions, includes in self-description | ✅ Full |
| Telegram | Bot command + message-out warning | ✅ Full |

---

## §2. Known gaps (Phase 4.2 work-list)

### Gap 1 — `/v1/ops/status` does NOT include tier-3 session count

**File**: `src/infra/http/health.ts` (`buildHealthPayload`)
**Current**: `health` endpoint returns version, providers, uptime, checks, runtime, surface policies, workPolling, scheduler. **Does not surface tier-3 state.**
**Why it's a gap**: operator running `curl /v1/ops/status | jq` cannot tell if tier-3 is active without making a separate call to `/v1/ops/tier3/sessions`. This is awkward for monitoring scripts.

**Phase 4.2 fix**:
```ts
// buildHealthPayload extension
tier3: {
  activeSessions: number,        // from src/security/tier3-session.ts listActiveSessions().length
  expiringWithinMinutes: number  // count of sessions where (expiresAt - now) < 5min, for alert dashboards
}
```

`/v1/ops/tier3/sessions` stays the privileged-detail endpoint (returns operator IDs, full audit trail). `/v1/ops/status` only counts.

### Gap 2 — `memphis doctor` does NOT report tier-3 state

**File**: `src/infra/cli/utils/doctor-v2.ts`
**Current**: `runDoctorChecksV2()` runs ~20 diagnostic checks; **none cover tier-3 elevation status**. Operator running `memphis doctor` after elevation has no visual confirmation that the elevation worked.
**Why it's a gap**: tier-3 elevation is rare and high-stakes. After granting, operator wants visible confirmation in the canonical health-check output. Currently they must remember to also run `memphis tier status`.

**Phase 4.2 fix** — add new section to `doctor-v2.ts`:
```
[Tier-3 Sessions]
  GREEN: 0 active (default state)
  GREEN: 1 active — surface=tui, expires in 2h 14m
  YELLOW: 1 active — surface=cli, expires in 4m 32s (>90% TTL elapsed)
  RED: stale session in audit log (lifecycle timer missed)
```

---

## §3. Audit trail (already complete)

All tier-3 events are persisted to the operator audit chain:
- `tier3-grant` — at session mint
- `tier3-expire` — at lifecycle timer fire
- `tier3-revoke` — at manual revocation

Each event includes: `actorId`, `surface`, `sessionId`, `grantedAt`, `expiresAt`, optional `reason`. **No changes needed in Phase 4.2** — this is well-covered.

---

## §4. Cross-reference — what's NOT here

This audit covers tier-3 (elevated) sessions only. Tier-0/1/2 are not session-based:
- **Tier 0** = unauthenticated public surface (e.g. `GET /` health probe). No session, no expiry.
- **Tier 1** = standard operator session — managed by `requireOperatorAuth` cache (15-min cookie, refreshes per call). See `CODEBASE-TRUTH-DELTA-2026-05-08.md` §5 for callsite list.
- **Tier 2** = sensitive ops without elevation — same gating as Tier 1 + tool/route access policy.

The `memphis tier elevate` command currently jumps from Tier 1 → Tier 3 directly (no intermediate Tier 2 elevation). This is intentional under the current model; Tier 2 is enforced at the route-policy layer, not by an explicit elevation step.

---

## §5. Verification (post-Phase-4.2)

After Phase 4.2 lands:

```bash
# Active session
memphis tier elevate --tier 3 --operator-passphrase "$PW"

# Gap 1 verified
curl -s http://localhost:3000/v1/ops/status | jq '.tier3'
# expected: { "activeSessions": 1, "expiringWithinMinutes": 0 }

# Cross-check
curl -s http://localhost:3000/v1/ops/tier3/sessions | jq 'length'
# expected: 1

# Gap 2 verified
memphis doctor 2>&1 | grep -A 1 "Tier-3"
# expected:
#   [Tier-3 Sessions]
#     GREEN: 1 active — surface=cli, expires in 2h 59m

# After revoke
memphis tier revoke
curl -s http://localhost:3000/v1/ops/status | jq '.tier3.activeSessions'
# expected: 0
```

---

## §6. Test coverage plan

`tests/integration/health-tier3.test.ts` (new in Phase 4.2):
1. Mint tier-3 session via test helper
2. Assert `/v1/ops/status` includes `tier3.activeSessions: 1`
3. Mint a session expiring in <5min
4. Assert `tier3.expiringWithinMinutes: 1`
5. Run doctor, assert "Tier-3 Sessions" section present with right count
6. Revoke session, repeat — assert reverts to 0

---

**Generated**: 2026-05-08 by autopilot Phase 0.5 (`automode-silly-pike`).
**Sources**: agent exploration of `src/security/tier3-session.ts`, `src/infra/tui-host/commands.ts`, `src/infra/http/auth-policy.ts`, `src/infra/http/server.ts`, `src/infra/cli/utils/doctor-v2.ts`, `src/infra/http/health.ts`.
