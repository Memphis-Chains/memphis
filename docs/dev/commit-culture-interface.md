# `memphis_commit_culture` — interface design

> Authored by Mavis (MiniMax-M3), 2026-09-22.
> Status: design draft. Code skeleton at `src/mcp/tools/commit-culture.ts`.

## Why

`memphis_git` (the existing tool) is a **thin wrapper** around git CLI. It enforces
_tiering_ (read vs write) and blocks dangerous args, but it does NOT enforce
project commit culture (conventional commits, postmortem cross-links, no
secrets, author sign). Today the culture lives in `AGENTS.md` + agent memory
only — meaning every commit is at the mercy of whoever runs it.

`memphis_commit_culture` adds the culture layer. It can be used:

1. **By memphis itself** (operator-tui, mcode agents) when committing in this repo
2. **By humans** via CLI/MCP when they want a culture-checked commit in 1 step

## Interface (TUI-style, minimal)

```text
memphis commit_culture [subcommand] [flags]

Subcommands
  auto      lint staged files, auto-detect type/scope/subject/link, then prompt y/N
  preview   show lint result + suggested message; do NOT commit
  dry-run   alias for preview
  amend     lint the last commit, offer to fix subject/body; --no-edit to keep

Flags (apply to all subcommands unless noted)
  --type <feat|fix|ci|docs|refactor|test|chore|perf|build>
  --scope <name>             (default: auto-detect from staged paths)
  --subject <text>           (max 80 chars; required for non-auto)
  --body <text>              (multi-line OK via stdin or --body @file)
  --link <postmortem-path>   (repeatable; auto-detected if absent)
  --co-author "<Name> <email>"  (repeatable)
  --no-verify                (skip pre-commit hook; rare)
  --allow-staged-novel       (override forbidden-files list; rare)

Examples
  memphis commit_culture auto
  memphis commit_culture --type fix --scope skills \
      --subject "halt-aware SKILL.md docs match A1 audit format" \
      --body "See: docs/postmortems/2026-09-22-..."
  memphis commit_culture preview --type feat --scope tools
  memphis commit_culture amend
```

## Behavior

### 1. Stage validation (always, even preview)

- `git diff --cached --name-only` → list of staged files
- Reject if **empty** (nothing staged)
- Reject if any path matches the forbidden list:
  ```
  .env, .env.*, vault-state.json, *.tier2-passphrase,
  .tier2-passphrase, .github-pat, dist/, node_modules/
  ```
  Use path basename + glob. Show the offending file and exit non-zero.

### 2. Scope auto-detection

Walk staged paths; pick the **most common top-level dir** under the repo:

- `skills/halt-aware-destructive-ops/...` → `skills`
- `src/mcp/tools/...` → `tools`
- `docs/postmortems/...` → `postmortems`
- Tie → use the path of the first staged file alphabetically.

### 3. Type auto-detection (heuristics, no LLM)

| Signal                                                | Suggested type |
| ----------------------------------------------------- | -------------- |
| Any new file under `tests/`, `*.test.ts`, `*_test.rs` | `test`         |
| Only changes to `docs/**`                             | `docs`         |
| Only changes to `.github/**`, `*.yml`, `Dockerfile`   | `ci`           |
| New file in any other dir                             | `feat`         |
| Modified only (no new files)                          | `fix`          |
| `package.json` only                                   | `chore`        |
| Bulk rename or only `*.lock` files                    | `chore`        |

Always print the suggested type and allow `--type` to override.

### 4. Subject rules

- Length: 3-80 chars (after type+scope prefix)
- First letter lowercase
- No trailing period
- Imperative mood ("add", not "added") — best-effort check, not blocking
- If subject is missing for `auto` mode: generate from the most common
  file basename → "update <basename>"

### 5. Cross-link auto-detection

Scan staged file contents for `docs/postmortems/YYYY-MM-DD-*.md` mentions.
If any found and `--link` not given, prepend to body:

```
See: docs/postmortems/2026-09-22-chains-halt-invalid-block-shape.md
```

### 6. Author / co-author

- Set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`
  from the operator profile (`~/.memphis/config/agent-profile.json`):
  - name: `Wodzu (Marcin Kukla)`
  - email: `wodzu@memphis.local`
- Each `--co-author` adds a `Co-authored-by: Name <email>` trailer.

### 7. Commit invocation

```
git commit -m "<type>(<scope>): <subject>" \
           -m "<body with link trailers>"
```

If body is empty and no links, single `-m`.

### 8. Audit

On success, append a `commit_culture.commit` event to `system` chain via
`memphis_decide` (if available) or directly to `~/.memphis/chains/system/`.
Schema:

```json
{
  "kind": "commit_culture.commit",
  "type": "governance_event",
  "subject": "fix(skills): halt-aware SKILL.md docs match A1 audit format",
  "files": ["skills/halt-aware-destructive-ops/SKILL.md", "..."],
  "co_authors": [],
  "hash": "<commit hash after git commit>"
}
```

## Tier & safety

- Same tier as `memphis_git commit` (tier 2 write)
- Restricted to `~/memphis/` (same path gate)
- BLOCKED_ARGS inherited from `memphis_git` (`--exec`, `-c`, shell metachars)
- Adds: forbidden-files check, type/scope/subject regex
- Never reads `.env`, `vault-state.json`, `*.tier2-passphrase` even if asked
  (file content never sent to the model)

## Future expansion (not in v0.1)

- Branch-name lint (`fix/<slug>-NNN`, `feat/<phase>-...`)
- Squash-detect for multi-commit branches
- PR description generator (uses same body)
- Co-author trailer for AI agents (e.g. `Co-authored-by: Mavis <mavis@mavis.local>`)
- `commit_culture.config` to override defaults per-project

## Open questions

1. Should `auto` mode actually call `git commit`, or always prompt? (default: prompt)
2. Should we lint the **last commit** on `amend`, or only new diff? (default: new diff)
3. Co-author detection from staged content? (e.g. grep for `Co-authored-by:` in body)
4. Should this tool live in `mcp/tools/` or as a skill (`halt-aware-destructive-ops`-style)?
