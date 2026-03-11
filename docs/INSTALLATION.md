# Memphis v5 Installation Guide (Ubuntu / WSL)

![Platform](https://img.shields.io/badge/platform-Ubuntu%20%7C%20WSL-0A84FF)
![Architecture](https://img.shields.io/badge/arch-linux--x64-6f42c1)
![Node](https://img.shields.io/badge/node-%E2%89%A524-339933)
![Rust](https://img.shields.io/badge/rust-stable-orange)

This guide covers **clean installation of Memphis v5 on Linux x64 only**:
- Ubuntu 22.04+ (native)
- WSL2 Ubuntu on Windows

For first usage after install, continue to [GETTING-STARTED.md](./GETTING-STARTED.md).

---

## 1) Prerequisites

### Required software

- **Node.js v24+**
- **npm** (bundled with Node.js)
- **Rust stable** (`rustc`, `cargo`)
- **Build toolchain** (`build-essential`)
- **git**, **curl**

### Quick prerequisite install (Ubuntu/WSL)

```bash
sudo apt-get update
sudo apt-get install -y build-essential git curl pkg-config libssl-dev
```

### Install Node.js 24 (NodeSource)

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
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

Choose one of the two supported methods.

## Option A (recommended): automated installer

Estimated time: **5-10 minutes** on warm network/cache, **10-20 minutes** on fresh hosts.

```bash
git clone https://github.com/Memphis-Chains/memphis-v5.git
cd memphis-v5
./scripts/install.sh
```

What the installer does:
1. Verifies platform and required tools
2. Ensures Node 24+ and Rust stable
3. Installs dependencies (`npm install`)
4. Builds project (`npm run build`)
5. Links CLI globally (`npm link`)
6. Creates first journal bootstrap entry
7. Runs `memphis health`

## Option B: manual installation

Estimated time: **8-15 minutes**.

```bash
git clone https://github.com/Memphis-Chains/memphis-v5.git
cd memphis-v5
npm install
npm run build
npm link
```

---

## 3) Post-install verification

Run all checks from repository root:

```bash
memphis health
npm run -s cli -- doctor --json
npm run test
```

Expected outcomes:
- `memphis health` exits successfully
- `doctor` returns JSON with `"ok": true`
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
DATABASE_URL=file:./data/memphis-v5.db
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

### `node -v` is below 24
Reinstall Node.js from NodeSource 24.x and reopen shell.

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
- [GETTING-STARTED.md](./GETTING-STARTED.md) — first memory workflow
- [CONFIGURATION.md](./CONFIGURATION.md) — provider and security setup
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — deep diagnostics
