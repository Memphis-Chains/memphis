# Cross-surface presence

Memphis runs several conversational surfaces in parallel — Telegram, the Rust
TUI, and the HTTP gateway. Before Sprint 5, each surface tracked its own
sessions and `/status` showed only local state: a Telegram `/status` had no
idea whether the TUI had just executed a command, and vice versa.

The `src/core/surface-presence.ts` module closes that gap with a single
in-memory registry shared by every surface in the same Node process.

## Registry API

```ts
recordSurfaceActivity({
  surface: 'telegram' | 'tui' | 'http' | string,
  actorId: string,                 // opaque — e.g. 'telegram:42' or 'local'
  tier?: 0 | 1 | 2 | 3,            // current surface tier for this actor
  tuiHostSessionId?: string,       // TUI host session, when applicable
  telegramChatId?: number | string, // Telegram chat id, when applicable
});

const snapshots = getActiveSurfacesSnapshot({ staleMs = 5 * 60_000 });
```

Each entry is keyed by surface. Repeat calls for the same surface update
`lastActivityMs`, merge actor ids into a set, and bump `activityCount`. Entries
older than `staleMs` stay in the snapshot but are flagged `stale: true`.

`formatSurfaceStatusLines(snapshots)` renders a human-readable block identical
across surfaces:

```
Active surfaces:
  telegram last turn 12s ago     tier 2   (chat 999)
  tui      last turn 4m ago      tier 3   (local)
  http     idle                  tier 2   (10.0.0.1)
```

## Call sites

Activity is recorded at the inbound edge of every surface:

| Surface  | Call site                                                        |
|----------|------------------------------------------------------------------|
| Telegram | `src/gateway/channels/telegram.ts` — `bot.on('message:text', …)` |
| TUI      | `src/infra/tui-host/commands.ts` — top of `executeTuiHostCommand` |
| HTTP     | `src/infra/http/server.ts` — `onRequest` hook, after auth passes |

## Surfacing the snapshot

Every `/status` path now renders the shared block:

- **Telegram** — `bot.command('status')` → `options.onStatus()` in
  `src/app/bootstrap.ts` composes version/LLM/bridge lines plus the output of
  `formatSurfaceStatusLines(getActiveSurfacesSnapshot())`.
- **TUI** — new `presence.snapshot` capability in
  `src/infra/tui-host/protocol.ts`; `executePresenceSnapshot` returns
  `{ snapshots, active, total }` and the Rust renderer
  (`append_presence_host_result` in `crates/memphis-tui/src/app.rs`) prints a
  per-surface line. The existing `health.status` also includes
  `surfaceStatus: string[]` so the standard TUI overview carries the same
  summary without an extra round-trip.
- **HTTP** — `GET /v1/ops/status` payload gets two new top-level fields:
  `activeSurfaces: SurfaceActivitySnapshot[]` and `surfaceStatus: string[]`.
  `buildHealthPayload` (consumed by both HTTP and TUI) also carries the same
  two fields.

## Durability across restarts

Presence is in-process; a restart zeros the map. To give operators a warm view
of who was active before a restart, the heartbeat watchdog snapshots active
surface ids into each `PulseEntry`:

```
- 2026-04-13T12:34:56.000Z HEARTBEAT health=healthy uptime=42s mode=A surfaces=telegram,tui
```

`loadPulseEntries()` parses that `surfaces=…` field back into
`PulseEntry.activeSurfaces?: string[]`. The field is optional so existing PULSE
logs keep parsing.

## Tests

- `tests/unit/surface-presence.test.ts` — registry semantics (TTL, multi-actor,
  tier updates, formatter output).
- `tests/integration/surface-presence-cross-surface.test.ts` — drive activity
  on one surface and assert another surface's capability sees it.
