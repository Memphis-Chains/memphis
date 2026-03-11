# Memphis v5 User Guide (Beta)

This guide is for everyday use. No deep engineering knowledge needed.

## Before You Start

Make sure setup is complete:

```bash
npm run -s cli -- doctor --json
```

If `ok` is `true`, continue.

---

## 1) Creating Memory Files

Memphis works best when your notes are consistent.

### Recommended folder

```bash
mkdir -p docs/memory
```

### Recommended file name

Use one file per day:

```text
docs/memory/YYYY-MM-DD.md
```

### Minimal template

```markdown
# Memory: YYYY-MM-DD

## Journal

- What happened?

## Decisions

- What did you choose and why?

## Next Steps

- What should happen next?
```

### Good habits

- Write short bullets, not long essays.
- Keep one topic per bullet.
- Add clear verbs: “deployed”, “fixed”, “decided”.
- Update daily instead of writing everything once a week.

---

## 2) Using Semantic Search

Semantic search finds meaning, not only exact words.

### A) Reset local embed index (optional for a clean test)

```bash
npm run -s cli -- embed reset
```

### B) Store notes into the index

```bash
npm run -s cli -- embed store --id note-1 --value "Moved project to local-first architecture"
npm run -s cli -- embed store --id note-2 --value "Need backup plan for memory database"
```

### C) Search by meaning

```bash
npm run -s cli -- embed search --query "offline architecture" --top-k 5 --tuned
```

### D) Interpret results

- Higher `score` = closer meaning match
- `top-k` controls how many results you get
- `--tuned` improves relevance for short human queries

---

## 3) Understanding Dependency Trees

In Memphis, dependency trees describe what depends on what (for example, decisions -> tasks -> outcomes).

### Practical way to use it

1. Keep links inside notes:
   - “Depends on Decision D-14”
   - “Blocked by task T-22”
2. Keep chain/index metadata healthy.
3. Rebuild indexes after major imports.

### Rebuild chain indexes

```bash
npm run -s cli -- chain rebuild
```

### Import structured history (optional)

```bash
npm run -s cli -- chain import_json --file ./your-export.json
```

Use this when migrating from another memory system.

---

## 4) Backup and Restore

Memphis stores runtime data locally (for example in `data/`). Keep backups simple and regular.

## Quick backup

```bash
mkdir -p backups
cp -r data "backups/data-$(date +%F-%H%M)"
```

## Quick restore

```bash
# Stop running Memphis process first
rm -rf data
cp -r backups/data-YYYY-MM-DD-HHMM data
```

## Safety checklist

- Run backup before major upgrades.
- Keep at least 7 daily backups.
- Test restore at least once per sprint.
- After restore, run:

```bash
npm run -s cli -- doctor --json
npm run -s cli -- health --json
```

---

## 5) Multi-Agent Setup

Beta includes sync/trade commands for multi-agent workflows.

### A) Push a chain to sync layer

```bash
npm run -s cli -- sync push --chain journal
```

### B) Pull by CID

```bash
npm run -s cli -- sync pull --cid <your-cid>
```

### C) Share memory blocks with another agent

```bash
npm run -s cli -- trade offer --recipient did:example:agent123 --blocks 1-20
npm run -s cli -- trade accept --file ./offer.json
```

### Notes

- Keep agent IDs (`did:...`) documented in your team runbook.
- Start with small block ranges for first tests.
- Confirm audit trail after sync/trade in your logs.

---

## Daily 2-Minute Routine

1. Add today’s notes (`docs/memory/YYYY-MM-DD.md`)
2. Store 1-3 important points in embeddings
3. Run one semantic query
4. Create backup
5. If using team mode: run one sync push

That’s enough to keep Memphis healthy and useful.
