# Memphis v5 Re-Installation Guide

Complete guide for clean uninstall and fresh installation of Memphis v5.

---

## 📋 Table of Contents

1. [Prerequisites](#prerequisites)
2. [Complete Uninstall](#complete-uninstall)
3. [Fresh Installation](#fresh-installation)
4. [Verification](#verification)
5. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before starting, ensure you have:

- ✅ **Node.js** v18+ (v24.14.0 recommended)
- ✅ **npm** v9+
- ✅ **Rust** toolchain (cargo, rustc)
- ✅ **Git**
- ✅ **Ollama** (optional, for embeddings)

### Check Prerequisites

```bash
# Check Node.js
node --version  # Should be v18+ or v24+

# Check npm
npm --version   # Should be v9+

# Check Rust
cargo --version  # Should be 1.70+

# Check Git
git --version

# Check Ollama (optional)
ollama --version
```

---

## Complete Uninstall

### Phase 1: Stop Services

```bash
# Stop all Memphis services
pkill -9 memphis 2>/dev/null || true
pkill -9 "memphis-*" 2>/dev/null || true

# Stop OpenClaw if running
pkill -9 openclaw 2>/dev/null || true

# Stop Ollama (optional)
sudo systemctl stop ollama 2>/dev/null || true
pkill -9 ollama 2>/dev/null || true
```

### Phase 2: Remove Global Packages

```bash
# Remove Memphis global packages
npm uninstall -g @memphis-chains/memphis 2>/dev/null || true
npm uninstall -g @memphis-chains/memphis-v5 2>/dev/null || true
npm uninstall -g memphis 2>/dev/null || true

# Remove OpenClaw global package
npm uninstall -g openclaw 2>/dev/null || true

# Verify removal
which memphis 2>/dev/null || echo "✓ memphis removed"
which openclaw 2>/dev/null || echo "✓ openclaw removed"
```

### Phase 3: Remove Directories

```bash
# Remove source directories
rm -rf ~/memphis 2>/dev/null || true
rm -rf ~/memphis-v5 2>/dev/null || true

# Remove data directories
rm -rf ~/.memphis 2>/dev/null || true
rm -rf ~/.openclaw 2>/dev/null || true

# Verify removal
ls -la ~/ | grep -E "memphis|openclaw" || echo "✓ All directories removed"
```

### Phase 4: Remove Config Files

```bash
# Remove Memphis config
rm -rf ~/.config/memphis 2>/dev/null || true
rm -rf ~/.local/share/memphis 2>/dev/null || true
rm -rf ~/.local/state/memphis 2>/dev/null || true

# Remove OpenClaw config
rm -rf ~/.config/openclaw 2>/dev/null || true
rm -rf ~/.local/share/openclaw 2>/dev/null || true
rm -rf ~/.local/state/openclaw 2>/dev/null || true
```

### Phase 5: Clean npm Cache

```bash
# Remove cached packages
rm -rf ~/.npm/_npx/*/node_modules/@memphis-chains 2>/dev/null || true
rm -rf ~/.npm/_npx/*/node_modules/memphis 2>/dev/null || true

# Clear npm cache
npm cache clean --force 2>/dev/null || true
```

### Phase 6: Verification

```bash
# Final verification
echo "=== UNINSTALL VERIFICATION ==="

which memphis 2>/dev/null && echo "❌ Memphis still in PATH" || echo "✓ Memphis not in PATH"
which openclaw 2>/dev/null && echo "❌ OpenClaw still in PATH" || echo "✓ OpenClaw not in PATH"

[ -d ~/memphis ] && echo "❌ ~/memphis exists" || echo "✓ ~/memphis removed"
[ -d ~/.memphis ] && echo "❌ ~/.memphis exists" || echo "✓ ~/.memphis removed"
[ -d ~/.openclaw ] && echo "❌ ~/.openclaw exists" || echo "✓ ~/.openclaw removed"

pgrep memphis >/dev/null && echo "❌ Memphis processes running" || echo "✓ No Memphis processes"
pgrep openclaw >/dev/null && echo "❌ OpenClaw processes running" || echo "✓ No OpenClaw processes"

echo "=== UNINSTALL COMPLETE ==="
```

---

## Fresh Installation

### Step 1: Clone Repository

```bash
cd ~
git clone https://github.com/Memphis-Chains/memphis-v5.git memphis
cd memphis
```

**Expected output:**
```
Cloning into 'memphis'...
remote: Enumerating objects: 2472, done.
remote: Counting objects: 100% (2472/2472), done.
remote: Compressing objects: 100% (1217/1217), done.
remote: Total 2472 (delta 1345), reused 2297 (delta 1170), pack-reused 0
Receiving objects: 100% (2472/2472), 8.21 MiB | 4.94 MiB/s, done.
Resolving deltas: 100% (1345/1345), done.
```

### Step 2: Install Dependencies

```bash
npm install
```

**Expected output:**
```
added 319 packages, and audited 320 packages in 15s

103 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```

### Step 3: Build Project

```bash
npm run build
```

**Expected output:**
```
> @memphis-chains/memphis@0.2.0-beta.1 build
> npm run build:rust && tsc -p tsconfig.json

   Compiling memphis-core v0.1.0
   Compiling memphis-vault v0.1.0
   Compiling memphis-embed v0.1.0
   Compiling memphis-napi v0.1.0
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 14s
```

**Build time:** ~1-2 minutes (depending on system)

### Step 4: Link Globally

```bash
npm link
```

**Expected output:**
```
added 1 package, and audited 320 packages in 1s

103 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities

/usr/local/bin/memphis -> /usr/local/lib/node_modules/@memphis-chains/memphis/bin/memphis.js
```

### Step 5: Verify Installation

```bash
# Check version
memphis --version
```

**Expected output:**
```
@memphis-chains/memphis/0.2.0-beta.1 linux-x64 node-v24.14.0
```

### Step 6: Run Doctor

```bash
# Run system diagnostics
memphis doctor
```

**Expected output:**
```
✓ Node.js: v24.14.0
✓ npm: 10.x.x
✓ Rust: 1.xx.x
✓ Cargo: 1.xx.x
✓ Binary: memphis-core.node exists
✓ Config: ~/.memphis/config.json

⚠ Ollama: Not installed (optional)
  Install: https://ollama.com/download
  Model: ollama pull nomic-embed-text
```

### Step 7: Configure (Optional)

```bash
# Interactive configuration wizard
memphis configure
```

This will:
- Set up default provider
- Configure memory paths
- Initialize vault (if needed)
- Set preferences

---

## Verification

### Full System Check

```bash
# 1. Check binary
memphis --version

# 2. Check doctor
memphis doctor

# 3. Check config
cat ~/.memphis/config.json

# 4. Test basic command
memphis health

# 5. Test cognitive models
memphis ask --input "What is Memphis?" --provider local-fallback
```

### OpenClaw Integration (Optional)

If using OpenClaw with Memphis plugin:

```bash
# 1. Install OpenClaw
npm install -g openclaw

# 2. Check OpenClaw version
openclaw --version

# 3. Check memory status
openclaw memory status

# 4. Configure memory provider (if needed)
# Edit ~/.openclaw/openclaw.json:
{
  "plugins": {
    "entries": {
      "memphis-memory": {
        "path": "~/memphis/packages/@memphis/openclaw-plugin",
        "enabled": true
      }
    }
  }
}

# 5. Restart OpenClaw
openclaw restart

# 6. Verify plugin loaded (NO warnings!)
openclaw memory status
```

**Expected output (NO warnings):**
```
Memory Search (main)
Provider: ollama (requested: ollama)
Model: nomic-embed-text
Sources: memory
Indexed: X/X files · Y chunks
Dirty: no
Store: ~/.openclaw/memory/main.sqlite
Vector: ready
Vector dims: 768
FTS: ready
```

### Ollama Setup (Optional)

If using embeddings:

```bash
# 1. Start Ollama
sudo systemctl start ollama

# 2. Pull embedding model
ollama pull nomic-embed-text

# 3. Verify model
ollama list | grep nomic

# 4. Test embedding
ollama run nomic-embed-text "test embedding"
```

---

## Troubleshooting

### Issue: `npm install` fails with permissions

**Solution:**
```bash
# Fix npm permissions
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc

# Retry
npm install
```

### Issue: Rust build fails

**Solution:**
```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Verify
cargo --version

# Retry build
npm run build
```

### Issue: `npm link` fails with permissions

**Solution:**
```bash
# Option 1: Use sudo
sudo npm link

# Option 2: Use npx instead
npx memphis --version
```

### Issue: `memphis: command not found`

**Solution:**
```bash
# Check if linked
npm list -g @memphis-chains/memphis

# Re-link
npm link

# Check PATH
echo $PATH | grep npm

# If not in PATH, add to ~/.bashrc
echo 'export PATH="/usr/local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### Issue: Ollama not found

**Solution:**
```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Start service
sudo systemctl start ollama
sudo systemctl enable ollama

# Pull model
ollama pull nomic-embed-text
```

### Issue: Plugin warning still appears

**Solution:**
```bash
# Ensure you're on latest version
cd ~/memphis
git pull origin main
npm install
npm run build
npm link

# Restart OpenClaw
openclaw restart

# Check status (should have NO warnings)
openclaw memory status
```

### Issue: Tests failing

**Solution:**
```bash
# Run tests
npm test

# If specific test fails, check test file
cat tests/unit/failing-test.test.ts

# Debug mode
npm test -- --reporter=verbose
```

### Issue: Build takes too long

**Normal build time:** 1-3 minutes

**If taking >5 minutes:**
```bash
# Check system resources
htop

# Clean rebuild
npm run clean
rm -rf node_modules
npm install
npm run build
```

---

## Quick Reference

### One-Line Uninstall

```bash
pkill -9 memphis; pkill -9 openclaw; npm uninstall -g @memphis-chains/memphis @memphis-chains/memphis-v5 memphis openclaw 2>/dev/null; rm -rf ~/memphis ~/memphis-v5 ~/.memphis ~/.openclaw ~/.config/memphis ~/.config/openclaw; echo "✓ Uninstall complete"
```

### One-Line Install

```bash
cd ~ && git clone https://github.com/Memphis-Chains/memphis-v5.git memphis && cd memphis && npm install && npm run build && npm link && memphis doctor
```

### Complete Reinstall (Uninstall + Install)

```bash
# Uninstall
pkill -9 memphis; pkill -9 openclaw; npm uninstall -g @memphis-chains/memphis @memphis-chains/memphis-v5 memphis openclaw 2>/dev/null; rm -rf ~/memphis ~/memphis-v5 ~/.memphis ~/.openclaw

# Reinstall
cd ~ && git clone https://github.com/Memphis-Chains/memphis-v5.git memphis && cd memphis && npm install && npm run build && npm link && memphis doctor
```

---

## Support

- **GitHub Issues:** https://github.com/Memphis-Chains/memphis-v5/issues
- **Documentation:** `~/memphis/docs/`
- **Community:** https://discord.com/invite/clawd

---

**Last Updated:** 2026-03-11
**Version:** 1.0.0
**Status:** Production-tested ✅
