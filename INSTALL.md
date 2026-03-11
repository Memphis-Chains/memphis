# Memphis v5 Installation Guide

## Quick Install (Recommended)

### Linux / macOS / WSL

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash
```

**Non-interactive mode:**

```bash
MEMPHIS_YES=1 curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash
```

**Skip OpenClaw plugin:**

```bash
MEMPHIS_SKIP_OPENCLOW_PLUGIN=1 curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash
```

---

## Manual Installation

### 1. Install Dependencies

**Node.js v24+:**

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

# macOS
brew install node@24
```

**Rust stable:**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env
```

**Ollama (recommended default runtime):**

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull nomic-embed-text
```

### 2. Clone & Build

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis-v5
npm install
npm run build
```

### 3. Initialize

```bash
npm link
memphis health
```

---

## Verify Installation

```bash
memphis --version  # Should show v0.2.0-beta.1 or later
memphis health     # Should return status: ok
```

---

## Install Beta Version from Package Registry

If you have access to GitHub Packages:

```bash
npm install @memphis-chains/memphis-v5@beta
```

Then verify:

```bash
npx memphis --version
```

---

## Next Steps

- Read [QUICKSTART.md](docs/QUICKSTART.md) for first steps
- Configure [OpenClaw integration](docs/OPENCLAW-INTEGRATION.md)
- Learn about [memory file format](docs/MEMORY-FILE-FORMAT.md)

---

## Troubleshooting

### Build fails with TypeScript errors

```bash
# Make sure you have latest code
git pull origin main
npm run build
```

### `memphis: command not found`

```bash
# Link globally
npm link

# Or use directly
npm run cli -- health
```

### Ollama not found (embeddings)

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull embedding model
ollama pull nomic-embed-text
```

Memphis will still install without Ollama and fall back to `local-fallback`, but embedding features configured for Ollama require the CLI/runtime.

---

## Installation Time

- **With dependencies:** ~5-10 minutes
- **Dependencies pre-installed:** ~2-3 minutes

---

**△⬡◈ Memphis v5 — OpenClaw's Memory Layer**
