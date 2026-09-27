# Postmortems — Memphis Runtime

**Last updated:** 2026-09-26

Post-incident analyses for Memphis runtime failures. **Each postmortem should have a corresponding issue or commit reference for traceability.**

## Current postmortems

| File | Date | Severity | Status | Related issue |
|---|---|---|---|---|
| [2026-09-22-chains-halt-invalid-block-shape.md](2026-09-22-chains-halt-invalid-block-shape.md) | 2026-09-22 | HIGH | Resolved (PR #385) | (related: GitHub issues around chain race condition) |
| [2026-09-21-soul-append-and-deep-restart.md](2026-09-21-soul-append-and-deep-restart.md) | 2026-09-21 | MEDIUM | Resolved | — |
| [2026-05-08-zawoja-and-runtime-state.md](2026-05-08-zawoja-and-runtime-state.md) | 2026-05-08 | LOW | Resolved | — |

## Format

Each postmortem follows this structure:

1. **Summary** — one-paragraph description of what happened
2. **Timeline** — UTC timestamps for each significant event
3. **Impact** — what was affected, severity (LOW/MED/HIGH/CRITICAL)
4. **Root cause** — the underlying reason (with VERIFIED / HYPOTHESIS marker)
5. **Resolution** — what fixed it (commit, PR, code change)
6. **Anti-confab** — what we are NOT claiming was the cause
7. **Action items** — concrete changes to make, with status (DONE / TODO)
8. **Related** — links to issues, ADRs, commits

## When to write one

Write a postmortem when:
- An incident caused user-visible degradation (downtime, data loss, incorrect behavior)
- A debugging session took >2 hours
- A failure mode was discovered that could recur

Do NOT write a postmortem for:
- Minor bugs found and fixed in <2 hours
- Issues that are already covered by an existing ADR
- Issues that are tracked in a GitHub issue (link to it instead)

## Related

- [docs/issues/](../issues/) — corresponding GitHub issue reports
- [docs/runbooks/](../runbooks/) — proactive runbooks for recurring scenarios
- [docs/adr/](../adr/) — architectural decisions
