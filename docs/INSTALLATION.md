# Memphis Installation Guide (Ubuntu / WSL)

![Platform](https://img.shields.io/badge/platform-Ubuntu%20%7C%20WSL-0A84FF)
![Architecture](https://img.shields.io/badge/arch-linux--x64-6f42c1)
![Node](https://img.shields.io/badge/node-%E2%89%A522-339933)
![Rust](https://img.shields.io/badge/rust-stable-orange)

This guide covers **clean installation of Memphis on Linux x64 only**:

- Ubuntu 22.04+ (native)
- WSL2 Ubuntu on Windows

For first usage after install, continue to [GETTING-STARTED.md](./GETTING-STARTED.md).

---

## 1) Prerequisites

### Required software

- **Node.js v22+**
- **npm** (bundled with Node.js)
- **Rust stable** (`rustc`, `cargo`)
- **Build toolchain** (`build-essential`)
- **git**, **curl**

### Quick prerequisite install (Ubuntu/WSL)

```bash
sudo apt-get update
sudo apt-get install -y build-essential git curl pkg-config libssl-dev
```

### Install Node.js 22 (NodeSource)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
npm -v
```

### Install Rust stable

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
source "$HOME/.cargo/env"
rustc --version
cargo --version
```

---

## 2) Installation paths

Choose one of the two available methods. The source-checkout bootstrap flow is the
canonical full-runtime GA path.

## Option A (recommended): automated bootstrap

Estimated time: **5-10 minutes** on warm network/cache, **10-20 minutes** on fresh hosts.

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
./scripts/bootstrap.sh
```

To verify the source-checkout installer contract without mutating the host:

```bash
bash ./scripts/install.sh --check-only --json
```

What `bootstrap.sh` does:

1. Creates `.env` from template if missing
2. Generates `MEMPHIS_API_TOKEN` and `MEMPHIS_VAULT_PEPPER`
3. Ensures agent profile (`~/.memphis/config/agent-profile.json`)
4. Auto-detects Ollama models and selects the first available
5. Installs npm dependencies if needed (`npm ci`)
6. Builds project (`npm run build`)
7. Initializes workspace context
8. Optionally installs systemd user service
9. Prints the next step: `memphis init`

After bootstrap, run the canonical controlled first-run:

```bash
memphis init
```

## Option B: manual installation

Estimated time: **8-15 minutes**.

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
npm install
npm run build
npm link
cp .env.example .env
```

After installation, optionally set up the systemd user service:
```bash
memphis service install
systemctl --user status memphis.service
```

---

## 3) Post-install verification

Run all checks from repository root:

```bash
memphis health
npm run -s cli -- doctor --json
npm run -s cli -- doctor --verbose
npm run test
```

Expected outcomes:

- `memphis health` exits successfully
- `doctor` returns JSON with `"ok": true`
- `doctor --verbose` includes stack traces only when you explicitly request them
- tests complete without failures

### Example expected `doctor` shape

```json
{
  "ok": true,
  "checks": [
    { "name": "node", "status": "pass" },
    { "name": "rust", "status": "pass" }
  ]
}
```

---

## 4) First runtime configuration

Create local config from template:

```bash
cp .env.example .env
```

Minimum development-safe recommendation:

```dotenv
NODE_ENV=development
DEFAULT_PROVIDER=local-fallback
RUST_CHAIN_ENABLED=false
DATABASE_URL=file:./data/memphis.db
```

For full configuration details, see [CONFIGURATION.md](./CONFIGURATION.md).

---

## 5) WSL-specific notes

- Use **WSL2** (not WSL1)
- Use Ubuntu distribution
- Keep repository under Linux filesystem (e.g., `~/projects`), not `/mnt/c/...`, to avoid filesystem performance issues
- If command resolution fails after `npm link`, restart shell and re-run:

```bash
hash -r
which memphis
```

---

## 6) Troubleshooting quick list

### `node -v` is below 22

Reinstall Node.js from NodeSource 22.x and reopen shell.

### `cargo: command not found`

Load Cargo env:

```bash
source "$HOME/.cargo/env"
```

Persist in shell profile:

```bash
echo 'source "$HOME/.cargo/env"' >> ~/.bashrc
```

### Native build fails (C/C++ toolchain)

Install missing compiler packages:

```bash
sudo apt-get install -y build-essential pkg-config libssl-dev
```

### `memphis` command not found after `npm link`

Confirm npm global bin path is on `PATH`:

```bash
npm bin -g
echo "$PATH"
```

---

## 7) Time budget summary

- Prerequisites (fresh Ubuntu/WSL): **10-20 min**
- Memphis install/build/link: **5-15 min**
- Verification + first config: **3-8 min**
- Total typical first-time setup: **20-40 min**

---

## 8) What to do next

Proceed to:

- [GUIDE-FIRST-BOOTSTRAP.md](./GUIDE-FIRST-BOOTSTRAP.md) — canonical `bootstrap -> init` first-run flow
- [CONFIGURATION.md](./CONFIGURATION.md) — provider and security setup
- [OPERATIONS-MANUAL.md](./OPERATIONS-MANUAL.md) — production operations
