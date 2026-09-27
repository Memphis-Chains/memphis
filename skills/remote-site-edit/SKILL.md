---
name: remote-site-edit
description: Edit files on a public-facing website's remote webroot (e.g., memphis-v5.pl). Use when operator asks to edit/update a website that is served from a local directory mounted as webroot on a server. Covers the full flow: find deploy target, snapshot current state, write new content, verify, rollback if needed. Includes hard rules for never deleting original without backup.
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

# Remote site edit — public webroot operations

When operator says "edytuj stronę", "deploy na X", "update the site", "push the file", or any variation of "make a change visible on a hosted site", they mean: write the new file to the public webroot on the server that serves that domain.

This is NOT a git push. This is NOT a GitHub Pages deploy. This is the operator's home server running nginx/apache that mounts a local directory and serves it as the public website.

## Trigger conditions

- Operator says "edytuj remote" / "edytuj stronę" / "deploy na X" / "publish to Y"
- Operator references a specific URL or domain ("memphis-v5.pl", "dsmxshop.com", etc.)
- A previous deployment discussion mentioned a specific public URL
- Operator asks to make a file change visible to public visitors

## Inputs the assistant must collect or infer

1. **Domain** — what URL is the operator talking about? (e.g., `memphis-v5.pl`, `marcin-kukla.pl`)
2. **File to edit** — which file(s)? (typically `index.html`, `sitemap.xml`, `llms.txt`)
3. **Source of truth** — where is the new version? (workspace source, pitch-deck HTML, etc.)
4. **Deploy target** — which local directory does nginx serve from?

Most of these can be inferred from context. If unclear, **ask before deploying** — public websites are not the place to guess.

## Common deploy target pattern

The operator runs a self-hosted server with a `/home/memphis/public/sites-deploy/<domain>/` structure:

```
/home/memphis/public/sites-deploy/
├── marcin-kukla.pl/
├── memphis-v5/                ← webroot for memphis-v5.pl (note: no `.pl`)
├── dsmxshop.com/
├── holiskool.pl/
└── ... other sites

/home/memphis/public/sites-discovery/<domain>/   ← staging/test area
```

Naming convention is inconsistent (`memphis-v5` vs `memphis-v5.pl`). Always `ls` the parent first to find the exact directory name.

## Workflow (5 steps)

```
1. FIND the deploy target
   ls /home/memphis/public/sites-deploy/
   ls /home/memphis/public/sites-deploy/<domain>/

2. SNAPSHOT current state (anti-confab: never delete without backup)
   cp /home/memphis/public/sites-deploy/<domain>/<file>.html \
      /home/memphis/public/sites-deploy/<domain>/<file>.html.backup-<timestamp>

3. COPY new content from source to target
   cp /home/memphis/<workspace-path>/<file>.html \
      /home/memphis/public/sites-deploy/<domain>/<file>.html

4. VERIFY
   md5sum <source> <target>                       ← files must match
   ls -la <target>                                ← check size + timestamp
   grep <expected-token> <target>                 ← check key content present
   # optionally: head -5 <target>                  ← first lines look right

5. REPORT to operator
   - source path
   - target path
   - backup path
   - md5 of both
   - which tokens verified present
```

## Anti-confab (hard rules — never break)

| Rule | Reason |
|---|---|
| **NEVER delete or overwrite a file in `/home/memphis/public/sites-deploy/` without first creating a `.backup-<timestamp>` copy** | The deploy directory is production. There is no git in there. If we overwrite wrong, the only way back is from backup. |
| **NEVER delete the backup after success** | Operator may want to roll back later. The backup is small (KB-MB) and lives next to the deploy. Storage cost is negligible. |
| **NEVER edit multiple files in one step without verifying the first** | If something is wrong, you want to know which change broke it. |
| **NEVER trust that nginx serves from the directory you wrote to** | The operator may have multiple webroots. `ls` the parent, verify the file, and ask if unclear. |
| **NEVER modify `.htaccess`, `nginx.conf`, or server config** | Out of scope. If the deploy isn't visible, the issue is server config, not the file. Tell the operator. |
| **NEVER delete files inside `/home/memphis/public/sites-deploy/<domain>/` even if they look stale** | They may be referenced by the live site. Removing breaks the deploy silently. |

## Backup naming convention

```
<original-filename>.backup-<YYYY-MM-DD>-<reason-slug>

Examples:
- index.html.backup-2026-09-26-pre-v2-landing
- index.html.backup-2026-04-19-pre-calendly-rebrand
- robots.txt.backup-2026-09-26-pre-llms-update
```

The `<reason-slug>` should describe the upcoming change, not the past state. This makes "what was this backup before" self-documenting.

## Files to NOT touch

Some files in the deploy directory are general-purpose site metadata that should only be updated when the operator explicitly says so:

| File pattern | What it is | When to update |
|---|---|---|
| `sitemap.xml` | Lists all pages for SEO | When adding/removing pages, not on every content edit |
| `robots.txt` | Crawler directives | When changing SEO policy |
| `llms.txt` | LLM-friendly site map | When site structure changes significantly |
| `agents.json` | AI agent manifest | When surface area changes |
| `.htaccess` | Apache rewrite/security | Never without operator explicit instruction |
| `nginx.conf`, `*.conf` | Server config | Out of scope |
| `index.html.backup-*` | Previous backup | Never delete |

For this session, **the safe default is: touch ONLY `index.html`** unless the operator names a specific other file.

## Verification checklist (post-deploy)

Run all of these after copying:

```bash
# 1. File exists with same size
ls -la /home/memphis/public/sites-deploy/<domain>/<file>

# 2. Hashes match
md5sum <source> <target>
# expected: two identical hashes

# 3. Key tokens present (no encoding issues, no truncation)
grep -c "<expected-token>" <target>
# expected: count > 0

# 4. Backup preserved
ls -la <backup-path>
# expected: backup file still exists, same size as original
```

## Rollback (if something goes wrong)

```bash
# Restore from backup
cp <backup-path> <target-path>

# Verify rollback
md5sum <backup-path> <target-path>
# expected: identical

# Report to operator that rollback succeeded
```

## When this skill does NOT apply

- Pure local file edits that should NOT be public (workspace source code, pitch deck HTML in `/home/memphis/memphis/docs/pitch/`, AGENTS.md, etc.) — those stay in workspace
- GitHub Pages deploys (handled by `gh` CLI pushing to a `gh-pages` branch)
- Docker image deploys (`docker push` + remote pull)
- Kubernetes/Helm deploys
- Server configuration changes (nginx reload, apache restart) — operator must do

## Related skills

- `memphis-hotfix` — for code bug fixes that cross layers
- `memphis-rebuild-rust` — for Rust compilation issues
- `halt-aware-destructive-ops` — pre-flight check for destructive ops (always use this before any `rm` in production deploy area)

## Components

- Skill doc (this file)
- Backup convention: `<file>.backup-<YYYY-MM-DD>-<reason-slug>`
- Source of truth for new content: `/home/memphis/memphis/docs/pitch/` or `/home/memphis/memphis/`

## Example: deploying a memphis-v5.pl landing update

```bash
# 1. Find deploy target
ls /home/memphis/public/sites-deploy/
# → see "memphis-v5" (no .pl)

# 2. Backup current index.html
cp /home/memphis/public/sites-deploy/memphis-v5/index.html \
   /home/memphis/public/sites-deploy/memphis-v5/index.html.backup-2026-09-26-pre-v2-landing

# 3. Copy new index.html from workspace source
cp /home/memphis/memphis/docs/pitch/memphis-v5-pl-landing.html \
   /home/memphis/public/sites-deploy/memphis-v5/index.html

# 4. Verify
md5sum /home/memphis/memphis/docs/pitch/memphis-v5-pl-landing.html \
       /home/memphis/public/sites-deploy/memphis-v5/index.html
# → both should be 6085450ae1fcb4d6a16c11fa093b12fa

ls -la /home/memphis/public/sites-deploy/memphis-v5/index.html
# → 29501 bytes, modified timestamp = today

grep -c "f4f1ea" /home/memphis/public/sites-deploy/memphis-v5/index.html
# → 2 (cream token present)

# 5. Report
# Operator: "memphis-v5.pl deployed. Source: docs/pitch/memphis-v5-pl-landing.html.
#           Target: sites-deploy/memphis-v5/index.html. Backup: sites-deploy/memphis-v5/index.html.backup-2026-09-26-pre-v2-landing.
#           MD5: 6085450ae1fcb4d6a16c11fa093b12fa. Cream + deep-red confirmed."
```

## Notes on this skill

- **Created 2026-09-26** after operator pointed out the gap ("nie masz na to skilla?")
- **Tier:** 0 — no vault, no passphrase
- **Idempotent:** running the same workflow twice produces the same result (the second run just rotates the backup)
- **Reversible:** as long as the backup exists, you can always roll back
- **Safe by default:** touches ONLY index.html (or operator-specified file), leaves other site metadata untouched
