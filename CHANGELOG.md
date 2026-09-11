## v1.13.1 - 2026-09-11

### Hardening and self-discipline

- **Anti-confab phase 6 (external facts labeling).** `src/gateway/system-prompt.ts` now requires every concrete figure about the external world (prices, legal fees, dates, statistics, etc.) to be labeled `VERIFIED` (fetched this turn), `UNVERIFIED ESTIMATE` (from model knowledge, not fetched), or `OUT OF SCOPE` (need to fetch). This closes a third anti-confab incident in two days.
- **WAL checkpoint runner.** `scripts/wal-checkpoint.mjs` runs `PRAGMA wal_checkpoint(TRUNCATE)` on `data/memphis.db` with a `PRAGMA integrity_check` guard. Designed to be invoked by a systemd user timer (`memphis-wal-checkpoint.{service,timer}`) every 6 hours with 0–5 min jitter (anti-thundering-herd). Pure Node 22, no native deps.
- **Gitignore hardening for private operator artifacts.** New explicit patterns for `docs/operator/*.{md,html}`, `docs/pilots/memphis-*.md`, `.agent-prompts/`, `.README-PROPOSAL*.md`, `.README-SESSION-NOTES.md`, `wp-json*.json`, and `*.bak-pre-*`. These were staged by mistake in the v1.13 cycle and are per-operator-machine, never part of Memphis public source.
- **ADR-003 versioning model accepted.** Source-code `package.json.version` is the single source of truth; git tags follow `vX.Y.Z`; codenames stay internal. The "v5" leak into the domain and `agents.json` is documented as a known inconsistency to be reconciled in a future release.
- **AUTHORS.md corrected.** Cognitive subpersonas are now listed by their actual runtime identifiers (Model A — Conscious Capture, Model B — Inferred Decisions, Model C — Pattern Recognition, Model D — Collective Coordination, Model E — Meta-Cognitive Reflection). Drafted placeholders that had no implementation (`Iskra`, `Codex Snapshot`, `Cline`, `Claude Code`, `OpenClaw`, `Hermes`) are removed.
- **LICENSE updated.** Copyright holder line now lists only Marcin Kukla; a third-party attribution footer points at `AUTHORS.md` and `NOTICE` for full contributor and dependency license info. Aligns with the corrected `AUTHORS.md`.

## Unreleased

## v1.13.0 - 2026-09-05
