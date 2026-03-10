# Memphis v4 — Simple Install Guide

> **One command to rule them all** 🎯

## Quick Install (Copy-Paste)

```bash
git clone https://github.com/Memphis-Chains/memphis-v4.git && \
cd memphis-v4 && \
./scripts/install.sh && \
sed -i "/^MEMPHIS_VAULT_PEPPER=$/c\MEMPHIS_VAULT_PEPPER=$(openssl rand -hex 32)" .env && \
npm run -s cli -- doctor
```

**That's it.** If doctor shows `"ok": true`, you're ready.

---

## What Gets Installed

| Component | Size | Purpose |
|-----------|------|---------|
| Node.js deps | ~100MB | CLI + TUI runtime |
| Rust toolchain | ~150MB | Native crypto + performance |
| Compiled crates | ~50MB | Vault + Embed + Chain |

**Total:** ~300MB download, ~500MB disk

---

## Why Rust?

Memphis uses Rust for **security-critical operations**:

- 🔐 **Vault Crypto** — Argon2id (memory-hard) + AES-256-GCM
- 🔍 **Vector Search** — Fast cosine similarity for embeddings
- 📦 **Chain Storage** — Efficient block hashing + validation

**Can I skip Rust?** No — vault encryption requires native crypto primitives.

---

## Troubleshooting

### Doctor fails with "missing keys: MEMPHIS_VAULT_PEPPER"

**Fix:**
```bash
sed -i "/^MEMPHIS_VAULT_PEPPER=$/c\MEMPHIS_VAULT_PEPPER=$(openssl rand -hex 32)" .env
```

### `cargo not found` after install

**Fix:**
```bash
source $HOME/.cargo/env
```

### Install hangs at "downloading Rust"

**Normal:** First Rust install takes 3-5 minutes. Subsequent runs are instant.

---

## Next Steps

After successful install:

```bash
# Test basic ask
npm run -s cli -- ask --input "Hello Memphis!" --provider local-fallback

# Initialize vault (requires fix - coming soon)
npm run -s cli -- vault init --passphrase "yoursecret" --recovery-question "Pet?" --recovery-answer "dog"

# Launch TUI
npm run -s cli -- tui
```

---

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| OS | Ubuntu 20.04 / macOS 11 | Ubuntu 24.04 / macOS 14 |
| RAM | 2GB | 4GB |
| Disk | 1GB | 2GB |
| Node.js | 20.x | 24.x |
| Internet | Required (first install) | — |

---

## Manual Install (Advanced)

If you prefer manual setup:

```bash
# 1. Prerequisites
sudo apt-get install -y build-essential cmake pkg-config git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# 2. Clone + build
git clone https://github.com/Memphis-Chains/memphis-v4.git
cd memphis-v4
npm install
cp .env.example .env
npm run build

# 3. Configure
sed -i "/^MEMPHIS_VAULT_PEPPER=$/c\MEMPHIS_VAULT_PEPPER=$(openssl rand -hex 32)" .env

# 4. Verify
source $HOME/.cargo/env
npm run -s cli -- doctor
```

---

## Need Help?

- 📖 Full docs: `docs/USER-QUICKSTART-GITHUB.md`
- 🐛 Issues: https://github.com/Memphis-Chains/memphis-v4/issues
- 💬 Discord: https://discord.com/invite/clawd

---

**Last updated:** 2026-03-10
**Tested on:** Ubuntu 24.04, Node v24.14.0, Rust 1.94.0
