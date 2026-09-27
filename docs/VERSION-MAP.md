# Memphis Documentation Version Map

**Last updated:** 2026-09-26 · **Memphis runtime version:** v1.13.3

This document answers: **"I'm reading Memphis docs — which docs are current for v1.13.3, which are obsolete, which are historical?"**

## Canonical current version: v1.13.3

When in doubt, treat any doc dated 2026-06-01 or later as **current** unless explicitly marked obsolete. Dated 2026-04-01 to 2026-05-31 = **review for staleness**. Earlier = **historical** (see archive/).

---

## Current vs. historical — what to use

| Doc category | Where current lives | What is historical |
|---|---|---|
| Operator (install, run, troubleshoot) | `docs/operator/` | Anything with `archive/2026-03-25-documentation-cleanup/` prefix |
| Architecture decisions (ADR) | `docs/adr/` (5 current) | None — all 5 ADRs are current as of 2026-09 |
| Release process | `docs/dev/RELEASE-PROCESS.md` | `docs/historical/RELEASE-PROCESS.md` (superseded) |
| User guide | `docs/operator/USER-GUIDE.md` (v1.3.0, currently the most complete) | `archive/2026-03-25-documentation-cleanup/USER-GUIDE.md` (beta snapshot) |
| Briefs (agent task briefs) | `docs/briefs/` (current, 2026-09) | None — all briefs are 2026-09 |
| Issues (GitHub-issue format) | `docs/issues/2026-09-26-*` (current MiniMax partnership) | `docs/issues/01-04-*` (2026-09 batch, processed) |
| Partnerships (outreach material) | `docs/partnerships/` (current) | None — all created this session |
| Pitch decks | `docs/pitch/` (current) | None — created 2026-09 |
| Postmortems | `docs/postmortems/` (current) | None — all 2026-09 |
| Releases | `docs/releases/` (5 files: v0.1.3, v0.2.0-rc.2, v0.2.0-rc.3, v1.13.3, v1.13.3-final) | All releases are historical reference |
| Roadmap | `docs/roadmap/` (current Y1 plan, public FAQ, post-v1.9 plan) | `docs/roadmap/archive/Y1-v1-2026-04-21.md` (superseded) |

---

## Version-numbering policy

Memphis runtime version is `MAJOR.MINOR.PATCH` (semver-ish):
- **MAJOR** changes when there's a breaking architecture decision (e.g., vault format change)
- **MINOR** changes when there's a new feature area (e.g., new chain type)
- **PATCH** changes for bugfixes and non-breaking improvements

Current release: **v1.13.3** (in `package.json` and `crates/memphis-napi/Cargo.toml`).

---

## How to update this map

When you add a new doc that supersedes an old one:
1. Edit the relevant `README.md` in the target directory
2. Add the new doc to the directory map in `docs/README.md`
3. If a doc is being deprecated, add a marker in its own frontmatter:
   ```
   ---
   status: deprecated
   superseded_by: docs/path/to/new.md
   ---
   ```
4. Do NOT delete historical docs — see ARCHIVE-POLICY.md

---

## Quick reference: "I'm a new operator, where do I start?"

1. **[operator/GETTING-STARTED.md](operator/GETTING-STARTED.md)** — first-run overview
2. **[operator/INSTALLATION.md](operator/INSTALLATION.md)** — install Memphis runtime
3. **[operator/QUICKSTART.md](operator/QUICKSTART.md)** — first conversation
4. **[operator/SLO.md](operator/SLO.md)** — operational targets
5. **[operator/TROUBLESHOOTING.md](operator/TROUBLESHOOTING.md)** — common issues

## Quick reference: "I'm integrating Memphis with mcode / MiniMax"

1. **[partnerships/2026-09-26-memphis-collective-plus-partnership.md](issues/2026-09-26-memphis-collective-plus-partnership.md)** — current proposal (open as GitHub issue on MiniMax-AI/minimax-code)
2. **[briefs/BRIEF-001-MCODE-THREE-WAY-COMM.md](briefs/BRIEF-001-MCODE-THREE-WAY-COMM.md)** — original brief
3. **[briefs/BRIEF-002-MCODE-REWORK-AGENTS-PERMISSION.md](briefs/BRIEF-002-MCODE-REWORK-AGENTS-PERMISSION.md)** — follow-up brief

## Quick reference: "I'm hacking on Memphis internals"

1. **[dev/DEVELOPER.md](dev/DEVELOPER.md)** — build, run, test loop
2. **[dev/CANONICAL-ARCHITECTURE.md](dev/CANONICAL-ARCHITECTURE.md)** — current architecture
3. **[adr/](adr/)** — past architectural decisions

## Quick reference: "I'm in an incident"

1. **[runbooks/](runbooks/)** — incident-specific runbooks
2. **[operator/TROUBLESHOOTING.md](operator/TROUBLESHOOTING.md)** — generic troubleshooting
3. **[postmortems/](postmortems/)** — recent post-incident analyses (don't repeat the same mistake)
