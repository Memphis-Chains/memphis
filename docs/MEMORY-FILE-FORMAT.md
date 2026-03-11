# Memphis Memory File Format (.md)

This document explains the recommended Markdown structure for Memphis memory files.

## Why Markdown?

Markdown memory files are:

- Human-readable
- Easy to version in Git
- Simple to search and summarize
- Compatible with Memphis semantic indexing workflows

## Recommended Location

```text
docs/memory/YYYY-MM-DD.md
```

Example:

```text
docs/memory/2026-03-11.md
```

## Recommended Structure

```markdown
# Memory: YYYY-MM-DD

## Session

- Time window / context
- Main objective

## Journal

- Event 1
- Event 2

## Decisions

- Decision: ...
  - Why: ...
  - Impact: ...

## Results

- What was completed
- What failed (if any)

## Next Steps

- [ ] Task 1
- [ ] Task 2

## Tags

- #project/name
- #type/decision
- #priority/high
```

## Section-by-Section Rules

### 1) Title

Use exactly one H1:

```markdown
# Memory: 2026-03-11
```

This makes parsing and archiving easier.

### 2) Journal

Use short bullet points in chronological order.

Good:

- “08:10 — Ran doctor check, all required checks passed.”

Avoid:

- Very long paragraphs with mixed topics.

### 3) Decisions

Each decision should include at least:

- what was decided
- why
- expected impact

This is critical for future recall and team handoffs.

### 4) Next Steps

Use checkbox tasks (`- [ ]`) for actionable follow-ups.
Mark done items as `- [x]`.

### 5) Tags

Use simple, stable tag taxonomy.

Suggested families:

- `#project/...`
- `#type/...` (`decision`, `bug`, `research`, `docs`, `test`)
- `#agent/...`
- `#priority/...`
- `#time/...`

## Naming and Formatting Conventions

- File name format: `YYYY-MM-DD.md`
- UTF-8 encoding
- One blank line between sections
- Prefer bullet lists over dense prose
- Keep sensitive secrets out of memory notes

## Minimal Example

```markdown
# Memory: 2026-03-11

## Session

- 09:00-09:30 CET
- Goal: Finish beta user docs

## Journal

- Drafted QUICKSTART.md
- Added OpenClaw integration instructions

## Decisions

- Decision: Prioritize non-technical language in docs
  - Why: Beta testers are mixed-skill users
  - Impact: Faster onboarding, fewer support questions

## Results

- 4 documentation files prepared for beta release

## Next Steps

- [ ] Run docs review with 2 beta testers
- [ ] Add screenshots in next iteration

## Tags

- #project/memphis-v5
- #type/docs
- #priority/high
- #agent/memphis
```

## Optional Advanced Blocks

For larger teams, you can add:

- `## Metrics` (tests passed, timings, counts)
- `## Risks` (known blockers)
- `## Links` (PRs, issues, artifacts)

Keep these optional; the core format above is enough for most users.
