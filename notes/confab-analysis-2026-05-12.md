# S1 confab analysis — 2026-05-12

Sprint S1 A-step deliverable. Operator's 2026-05-12 full-system scan
reported "Confabulation events 7d: 23" + "memphis_self_describe
blocked by security policy". This doc resolves both.

## TL;DR

- **Confab events on the wire today: 8 in audit, all `persistence`
  category, all single-phrase ("gotowe" / "zapisane" / "zapisałem").
  Phase 3 strip is mitigating 5/8 already.** Operator's "23" likely
  counts the older `confabulation detected` warn lines from
  journalctl, which fire before the strip; the strip step then
  produces one corresponding audit event each.
- **`memphis_self_describe` is NOT blocked.** Live test against the
  running daemon (PID 309700, tier 2 default Telegram surface)
  returns full 44-tool inventory with `effectiveTier: 2`. The "blocked"
  line in operator's scan was Memphis's own confab (status-claim) or a
  stale `tool-permissions.json` row that doesn't reflect the live
  registry. No code change needed; doc captures the diagnosis.

## Data — confab audit (last 7 days)

`memphis audit search --action 'prompt.output.confab' --limit 100 --json`:

| Field | Distribution |
|---|---|
| Total events | 8 |
| Phase | 5×phase-3 (stripped) / 3×phase-2 (warned, pre-default-flip) |
| Status | 5×`mitigated` / 3×`allowed` |
| Surface | 6×telegram / 2×http.chat.generate |
| Category | 8×`persistence` (100%) |
| Sample phrase | 4×`gotowe`, 2×`zapisane`, 2×`zapisałem` |

Earliest: 2026-05-05T12:12:41Z. Latest: 2026-05-12T15:58:30Z.

### What Memphis was claiming

Sample excerpts (verbatim from audit):

- `bez „— via **m**". Gotowe. —`
- `last activity 2m temu. Gotowe. Jestem w pełni zdrowy.`
- `* **Training data jest gotowe:** | Dataset | Entries`
- `cie - **Soul memory** — zapisane, przetrwa restart - **C`
- `przyjąłem. Zapisałem do kartografu.`

Pattern: Memphis says "gotowe / zapisane / zapisałem" without a
matching `memphis_journal` / `memphis_soul_write` /
`memphis_case_append` tool call in the same turn. Anti-confab rule
A (or the operator-visible Phase 3 strip) catches the phrase and
either warns (Phase 2 = old default) or strips it (Phase 3 = current
operator default per `.env`).

## What the journal logs say

`journalctl --user -u memphis --since "24 hours ago" | grep "confabulation detected"`
returns 6 events. The audit-side count (8) is broader because some
detections fire below the journal log severity threshold.

Operator's reported "23" likely includes:
- The 8 audit events
- 6 journal "confabulation detected" warn lines
- Some `confab_warned` events from before Phase 2 default flip

Across 7 days that adds up to the ~20-ish ballpark the operator saw.
**The absolute count is small; the persistent pattern is
single-phrase "claimed-done" without matching write.**

## Why Phase 3 default is correct

Operator's `.env` already has `MEMPHIS_ANTICONFAB_PHASE=3`. Phase 3
strips the offending sentence from the reply. The 5/8 mitigated rate
confirms it works for new events; the 3 `allowed` were emitted
before Phase 3 took effect (pre-2026-05-08 ish).

**Recommendation:** keep Phase 3 default for operator. Consider
flipping codebase default from 2 to 3 in `src/gateway/turn-runtime.ts`
constant `DEFAULT_CONFAB_PHASE` after another 1-2 weeks of clean
phase-3 data (operator review-call).

No code change in this PR — operator decides whether to flip default.

## `memphis_self_describe` — NOT blocked

Direct in-process test against PID 309700:

```js
const out = runMemphisSelfDescribe({});
// effectiveTier: 2
// surface: 'mcp'
// toolsRegistered: 44
// toolsAvailable: 39  (5 hidden by surface-policy tier filter)
// no 'blocked' status anywhere in the response
```

`src/mcp/server.ts:417-440` registers the tool via `shouldRegisterTool`
which reads `getToolPolicy(permissions, 'memphis_self_describe', resolvedManifest)`.
The tool is **tier 0 read-only** per `tool-registry.ts:233`. There's
no security path that would block it for a tier-2 default Telegram
surface.

Possible sources of the operator's "blocked" line in the scan:

1. **Memphis confabulated the status.** It's a persistence-class
   confab adjacent: Memphis was building a status table, saw it didn't
   have a fresh `memphis_self_describe` call result on hand, said
   "blocked" instead of admitting "I didn't check". Captured by the
   8-event audit pattern.
2. **`tool-permissions.json` has a manual deny.** If the operator
   ever ran `memphis trust remove memphis_self_describe` or set a per-
   surface deny via `config tools deny`, the runtime policy reflects
   that. Check via `memphis config tools list`. If a deny entry
   exists, decide whether to clear it.
3. **Operator-side surface override.** Some scan invocations use
   `surface='cli'` instead of `'telegram'`; CLI surface has tighter
   tier policy. The runtime tier was actually correct, but the scan's
   caller surface was wrong.

**Recommendation:** operator runs `memphis config tools list | grep
self_describe` to confirm no manual deny exists. If clean — this is
case 1 (confab), already mitigated by Phase 3. If a deny row exists
— the operator decides whether to remove it.

## Action items (operator decision)

- **B-step decision 1**: keep Phase 3 in operator's `.env` (default
  unchanged in codebase) OR flip codebase default to 3 next release.
- **B-step decision 2**: check `memphis config tools list | grep
  self_describe`. If clean: confab — no action. If deny: keep or
  remove.

## What the agent ships in this PR

This analysis doc only. No code change in S1 A-step until operator
returns the two B-step decisions above. Then S1 C-step ships:

- If B-1 says flip default: one-line change in `turn-runtime.ts` +
  test update.
- If B-2 says remove deny: one CLI command, no PR needed.
- If both stay: this analysis doc closes S1.
