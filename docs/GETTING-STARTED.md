# Getting Started with Memphis v5

![Status](https://img.shields.io/badge/status-beta-blue)
![Runtime](https://img.shields.io/badge/runtime-local--first-success)

This document covers the first 15-30 minutes after successful installation.

**Prerequisite:** complete [INSTALLATION.md](./INSTALLATION.md).

---

## 1) Validate runtime health

From repository root:

```bash
npm run -s cli -- doctor --json
npm run -s cli -- health --json
```

If both checks pass, continue.

---

## 2) Create your first memory entry

Memphis supports journaling via reflection.

```bash
# saves a reflection/journal entry
memphis reflect --save
```

Alternative pattern (explicit daily markdown memory file):

```bash
mkdir -p docs/memory
cat > "docs/memory/$(date +%F).md" <<'EOF'
# Memory: $(date +%F)

## Journal
- Installed Memphis v5 and validated health checks.

## Decisions
- Start with local-fallback provider for baseline stability.

## Next Steps
- Enable provider integration after local smoke checks.
EOF
```

---

## 3) Basic commands you should know

### Journal

```bash
memphis reflect --save
```

### Search (semantic embeddings)

```bash
npm run -s cli -- embed store --id note-1 --value "Use local-first memory and verify health daily"
npm run -s cli -- embed search --query "daily runtime verification" --top-k 5 --tuned
```

### Health

```bash
memphis health
npm run -s cli -- doctor --json
```

### Optional chain maintenance

```bash
npm run -s cli -- chain rebuild
```

---

## 4) Understanding chains (practical model)

A chain is an integrity-linked sequence of memory/decision blocks.

Use chains for:

- durable historical context
- chronological decision tracking
- index rebuild and import/export workflows

Key commands:

```bash
# rebuild chain indexes
npm run -s cli -- chain rebuild

# import existing chain data
npm run -s cli -- chain import_json --file ./your-export.json --write --confirm-write
```

If Rust chain mode is disabled (`RUST_CHAIN_ENABLED=false`), Memphis uses the TypeScript fallback path.

For technical internals, see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 5) Configuration basics

1. Copy template:

```bash
cp .env.example .env
```

2. Set baseline values:

```dotenv
NODE_ENV=development
DEFAULT_PROVIDER=local-fallback
DATABASE_URL=file:./data/memphis-v5.db
RUST_CHAIN_ENABLED=false
```

3. Re-run validation:

```bash
npm run -s cli -- doctor --json
```

For full variable reference and provider setup, see [CONFIGURATION.md](./CONFIGURATION.md).

---

## 6) Recommended first-day workflow

1. Start with `doctor` and `health`
2. Save at least one journal entry (`reflect --save`)
3. Store 2-3 semantic notes and run one `embed search`
4. Rebuild chain index once (`chain rebuild`)
5. Confirm `.env` baseline and provider choice

---

## 7) Next steps

- Read [CONFIGURATION.md](./CONFIGURATION.md) to configure provider/security settings
- Read [ARCHITECTURE.md](./ARCHITECTURE.md) for system internals and data flow
- Use [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) if any command fails
