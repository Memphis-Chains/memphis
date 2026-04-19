# Root cleanup — 2026-04-19

Surfaced by Wodzu's deep-review (2026-04-19): repo root accumulated 25 `.md`
files, mixing current operational docs with historical / superseded ones.
PR #108 archived 40 historical planning docs back in 2026-04-14, but the
root drifted again with new release-note + roadmap files.

This batch moves 12 stale files out of root into this archive directory:

- `RELEASE-NOTES-v0.2.0-beta.md` — v0.2.0 was three minor versions ago
- `RELEASE-NOTES-v0.3.0-beta.3.md` — v0.3.0-beta.3 superseded by v1.x line
- `MEMPHIS-V4-CODELINE-BLUEPRINT.md` — V4 was abandoned; V5 already in archive
- `ROADMAP-MASTER-QUEUE.md` — replaced by `docs/ROADMAP-CURRENT.md`
- `ROADMAP.md` — replaced by `docs/ROADMAP-CURRENT.md`
- `CONTEXT_RESET_HANDOFF_v1.8.md` — handoff for a version that never shipped
- `IMPLEMENTATION_PROGRESS.md` — Iteration #1 from version 0.1.0 era
- `SPRINT_STATUS.md` — self-described "Superseded repo-local sprint board"
- `BETA-TESTING-CHECKLIST.md` — beta phase ended with v1.0.0
- `REVIEW_REQUIRED_GREEN_GATES.md` — dated 2026-03-25, "1108/1108 passing" (current is 2054/2054)
- `PRODUCTION-BRIEF.md` — self-described "Non-canonical planning note"
- `PROFILES-MARKETING.md` — Memphis 1.0.0 marketing profiles, predates current Watra branding

Files retained in root after this cleanup (13 total):

- `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE` (required by GitHub)
- `INSTALL.md`, `NPM-INSTALL.md`, `CLI_COMMANDS.md` (user-facing)
- `AGENTS.md`, `CLAUDE.md` (agent context)
- `CHANGELOG.md` (release log)
- `ADR-001-architecture-choice.md`, `ADR-002-storage-state-choice.md` (architecture decisions)
- `MEMPHIS_AI_STACK.md`, `MEMPHIS-FEDERATION-DESIGN.md` (active design docs)
