# Memphis Documentation Archive Policy

**Last updated:** 2026-09-26 · applies to all `docs/` content

When documentation becomes obsolete or historical, where should it go?

## TL;DR

- **`docs/archive/<dated-folder>/`** — closed-epoch content (e.g., a sprint's worth of work that's done)
- **`docs/historical/`** — undated operational docs that were superseded but kept for reference
- **Top-level dir + `README.md` edit** — if you just want to note "this is the old version" without moving
- **Do not delete** anything in `archive/` or `historical/` without explicit operator approval

---

## Decision tree

```
Is the content tied to a specific dated event (sprint, release, cleanup)?
  ├── Yes → docs/archive/<YYYY-MM-DD>-<event-name>/
  │          Example: docs/archive/2026-04-19-root-cleanup/
  │
  └── No, it's a generic doc that was superseded
      ├── Was the original in a top-level dir (operator/, dev/, etc.)?
      │   └── Yes → docs/historical/<original-name>.md
      │             Example: docs/historical/RELEASE-PROCESS.md
      │
      └── Was the original already inside a dated archive?
          └── It can stay in archive/ — historical/ is for top-level docs only
```

---

## What each directory is for

### `docs/archive/<dated-folder>/`

- **Format:** `YYYY-MM-DD-<event-name>/` (e.g., `2026-04-19-root-cleanup/`)
- **One folder per discrete historical event**
- **Subdirectories represent cleanup milestones**, not topical groupings
- **Content is preserved as-is** — no rewrites, no "modernizing" old docs
- **Access pattern:** "What did we decide in sprint X?" → look in `archive/YYYY-MM-DD-X/`

**Current archive/ subdirectories:**
- `2026-03-25-documentation-cleanup/` — pre-ADR doc structure
- `2026-04-14-post-roadmap-cleanup/` — sprint-3-to-M8 roadmap
- `2026-04-19-root-cleanup/` — root file reorganization
- `2026-05-06-zawoja-speech.md` — single-file artifact from a specific event

### `docs/historical/`

- **Format:** undated `<original-name>.md`
- **Houses superseded top-level operational docs** (e.g., `historical/RELEASE-PROCESS.md`)
- **Should be rare** — most docs either get updated in place or archived with a date
- **Content preserved as-is** — same rule as archive/

**When to use historical/ vs just updating the doc:**
- Use `historical/` when the doc is being replaced by a NEW doc (different filename, different approach)
- Update in place when the doc is just getting better/clearer

---

## What archive/ and historical/ are NOT for

- ❌ Work-in-progress drafts → use `docs/dev/` or topic-specific dirs
- ❌ Recent but slightly stale content → just update the doc in place
- ❌ Personal notes → use `notes/` (operator-local, not in git)
- ❌ Random one-off files → file a PR if you need them tracked

---

## Operator override

If you have specific files that don't fit the policy:
- Ask before bulk-moving content
- Document the move in a decision chain entry (e.g., "moved 12 files from `archive/2026-04-19-root-cleanup/` to `historical/` because they were generic operational docs, not cleanup-specific")
- Update this policy if the pattern emerges more than twice

---

## Related

- [VERSION-MAP.md](VERSION-MAP.md) — what version each doc applies to
- [README.md](README.md) — directory map for active docs
