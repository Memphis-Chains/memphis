# Review Required Green Gates

## Status: ALL GATES PASSING ✅

**Last Updated:** 2026-03-25 13:14
**Test Suite:** 1108/1108 passing ✅ (252 test files)

---

## Historical Context

This file previously documented 5 failing tests from before commit `d1fc2d8`.
Those tests are now passing after the dispatcher bug fix.

The failures were:
- `cli.vault.test.ts` — operator-gate mock missing
- `cli.apps.test.ts` — operator-gate mock missing
- `cli.backup.test.ts` — operator-gate mock missing
- `full-workflow.e2e.test.ts` — operator-gate mock missing
- `vault-routes.e2e.test.ts` — legacy vault contract

**Root cause:** Missing `vi.mock` for `operator-gate.js` in multiple test files.
**Fix:** Added operator-gate mock in all affected test files.

---

## Current Test Status

```
npm run test:ts  # 1108/1108 passing ✅
npm run typecheck  # PASS ✅
npm run lint  # PASS ✅
```

**Note (2026-03-25):** `vitest.config.ts` updated to set `RUST_CHAIN_ENABLED: 'true'` in test env.
Previously vault.test.ts failed locally without manual `RUST_CHAIN_ENABLED=true` override because
`.env` has `RUST_CHAIN_ENABLED=false`. CI workflow already sets `RUST_CHAIN_ENABLED: 'true'`
in the test job. Local now matches CI.

---

## Matrix Federation Phase 1-2

Implemented and committed:

- `src/sync/transport.ts` — SyncTransport interface
- `src/sync/websocket-transport.ts` — WebSocket transport with B1/B2 fixes
- `src/federation/matrix/*.ts` — MatrixClient, MatrixTransport, room, types
- `src/sync/protocol.ts` — refactored for transport-agnostic

### Bugs Fixed
- B1: `readyState` check before registering listener
- B2: Message handler reference stored and removed in `close()`
- B3: `roomMessageHandler` nulled in `close()`
- leaveRoom URL: `/join/{room}/leave` → `/rooms/{room}/leave`
- Race condition: local socket variable prevents null reference

### TODOs (EC1-EC4)
- EC1: Room discovery (`ensureRoom()`)
- EC2: Reconnect logic
- EC3: Token refresh (throws on 401)
- EC4: Message dedupe by `envelope.id`

---

## Next: Self-Hosted Matrix Setup

Planned for next sprint:
- Docker Compose for Synapse
- `memphis setup` wizard extension
- Admin API registration with shared secret
- Pre-configured homeserver.yaml
