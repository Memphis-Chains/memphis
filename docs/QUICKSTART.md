# Memphis v5 Quick Start (5 minutes)

Welcome! This guide gets Memphis running with the smallest possible setup.

## What You'll Get

- AI memory that learns from your files
- Semantic search across all your notes
- Works offline, private, secure

## Installation (3 steps)

### 1) Install dependencies (Node.js + Rust)

You need:
- Node.js 20+
- Rust + Cargo
- Git

If you are on Ubuntu/Debian/macOS, the easiest way is:

```bash
./scripts/install.sh
```

This installer prepares dependencies, installs packages, creates `.env` (if missing), and builds Memphis.

---

### 2) Clone and build

If you did not clone yet:

```bash
git clone https://github.com/Memphis-Chains/memphis-v5.git
cd memphis-v5
npm install
npm run build
```

---

### 3) Initialize Memphis

Create a local config profile and verify health:

```bash
npm run -s cli -- onboarding wizard --write --profile dev-local --out .env --force
npm run -s cli -- doctor --json
```

If doctor returns `"ok": true`, Memphis is ready.

## Your First Memory

### Step 4) Create a memory file

Create a simple daily memory note:

```bash
mkdir -p docs/memory
cat > docs/memory/$(date +%F).md << 'EOF'
# Memory: $(date +%F)

## Journal
- Today I installed Memphis v5.
- First goal: store and search my notes.

## Decisions
- Keep setup local-first.
EOF
```

### Step 5) Search it semantically

Store and search using the embed pipeline:

```bash
npm run -s cli -- embed reset
npm run -s cli -- embed store --id first-note --value "Today I installed Memphis v5 and want local-first memory"
npm run -s cli -- embed search --query "local memory" --top-k 5 --tuned
```

You should see your note in results with a relevance score.

## Next Steps

- Connect to OpenClaw (see [`OPENCLAW-INTEGRATION.md`](./OPENCLAW-INTEGRATION.md))
- Multi-agent sync (`sync push/pull`, `trade offer/accept`)
- Advanced features (`mcp serve`, vault encryption, onboarding profiles)

---

Need help? Use:

```bash
npm run -s cli -- help
```