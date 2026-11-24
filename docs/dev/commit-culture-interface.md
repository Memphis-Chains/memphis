# Commit culture — the rules, and where they are enforced

> Authored by Mavis (MiniMax-M3), 2026-09-22.
> Revised 2026-11-22: the `memphis_commit_culture` TOOL was never built. The
> RULES below are real and are still applied — by the pre-commit hook and by
> the agent manifest. What did not exist was the tool.

## Status — read this first

There is **no** `memphis_commit_culture` tool, CLI subcommand or MCP surface.
There never was one on this host: the 2026-09-22 hardening sprint wired a
skeleton into `src/mcp/server.ts`, the tool-surface audit flagged the
server-without-registry mismatch, and the wire-up was rolled back. The stub
that survived the rollback computed a policy for a tool that was never
registered and then discarded it (`void _commitCulturePolicy`). It was dead
code in a file that is supposed to describe the live surface, and it was
removed on 2026-11-22.

This document therefore describes **the culture**, not an interface. Everything
below was written as an interface design and never implemented as code; the
rules themselves are what the host actually follows, so the rules are kept and
the interface framing is dropped.

## Why the culture exists

`memphis_git` (the existing tool) is a **thin wrapper** around the git CLI. It
enforces _tiering_ (read vs write) and blocks dangerous args, but it does NOT
enforce project commit culture (conventional commits, postmortem cross-links,
no secrets, author sign). Left to memory, the culture is at the mercy of
whoever runs it — so the parts that CAN be mechanical, are.

## The rules

### 1. Forbidden paths in the staging area

A commit must not carry any of:

```
.env, .env.*, vault-state.json, *.tier2-passphrase,
.tier2-passphrase, .github-pat, dist/, node_modules/
```

Match on the path basename and on the path glob. Name the offending file and
stop.

### 2. Scope auto-detection

Walk the staged paths; pick the **most common top-level dir** under the repo:

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

The suggested type is printed and can be overridden.

### 4. Subject rules

- Length: 3-80 chars (after the `type(scope):` prefix)
- First letter lowercase
- No trailing period
- Imperative mood ("add", not "added") — best-effort, not blocking
- A missing subject for an automatic commit is generated from the most common
  file basename → "update <basename>"

### 5. Cross-link auto-detection

Scan the staged file contents for `docs/postmortems/YYYY-MM-DD-*.md` mentions.
If any are found and no link was given, put them in the body:

```
See: docs/postmortems/2026-09-22-chains-halt-invalid-block-shape.md
```

### 6. Author / co-author

- `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`,
  `GIT_COMMITTER_EMAIL` come from the operator profile
  (`~/.memphis/config/agent-profile.json`):
  - name: `Wodzu (Marcin Kukla)`
  - email: `wodzu@memphis.local`
- Every agent adds the trailer
  `Co-authored-by: Wodzu (Marcin Kukla) <wodzu@memphis.local>`

### 7. Commit invocation

```
git commit -m "<type>(<scope>): <subject>" \
           -m "<body with link trailers>"
```

One `-m` when the body is empty and there are no links.

### 8. Audit

The decision belongs in the `decisions` chain (through `memphis_decide` /
`runMemphisDecide`), not in a chain write performed by hand. The
`governance_event` kind named in the original design is not writable from
outside the tools: rule 4 of the operator manifest forbids direct writes to
`chains/`, so a commit-culture audit event has nowhere legal to land.

## Where each rule is enforced TODAY

| Rule | Enforced by | Automatic? |
| --- | --- | --- |
| 1 — forbidden paths | the agent, from the operator manifest | no |
| 2/3/4 — type, scope, subject | the agent, from the operator manifest | no |
| 5 — postmortem cross-link | the agent, from the operator manifest | no |
| 6 — author and trailer | the agent, from the operator manifest | no |
| lint | `.githooks/pre-commit` (`npm run lint`) | yes |
| mutation gate | `.githooks/pre-commit`, when a guarded file is staged | yes |
| systemd unit gate | `.githooks/pre-commit`, when a unit file is staged | yes |

The hook is installed through `core.hooksPath` (`.githooks`) by
`scripts/setup-githooks.mjs`.

## What a future implementation would have to add

Only the rules marked "no" above. A tool would need to run the staging-area
checks, propose a message, and — for the audit — write through the chain
tools, never to `chains/` directly. Until such a tool exists, the rules above
are the specification and the agent manifest is the enforcement.

## Open questions

1. Should an automatic mode actually call `git commit`, or always prompt?
   (default: prompt)
2. Should an amend lint the **last commit**, or only the new diff?
   (default: new diff)
3. Co-author detection from the staged content?
4. Should the tool live in `mcp/tools/` or as a skill
   (`halt-aware-destructive-ops`-style)?
