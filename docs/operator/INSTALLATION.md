# Memphis Installation Guide (Ubuntu / WSL)

![Platform](https://img.shields.io/badge/platform-Ubuntu%20%7C%20WSL-0A84FF)
![Architecture](https://img.shields.io/badge/arch-linux--x64-6f42c1)
![Node](https://img.shields.io/badge/node-%E2%89%A522-339933)
![Rust](https://img.shields.io/badge/rust-stable-orange)

This guide covers the active Memphis `v1.x` local-runtime install path on Linux
x64:

- Ubuntu 22.04+ (native)
- WSL2 Ubuntu on Windows

The canonical full-runtime path is source checkout plus bootstrap. GitHub
Packages, the npm tarball, and one-shot install helpers are bounded
distribution surfaces, not the primary operator story.

For the shortest operator path after install, continue to
[GETTING-STARTED.md](./GETTING-STARTED.md).

---

## 1) Prerequisites

### Required software

- Node.js 22 LTS or newer
- npm
- Rust stable (`cargo`, `rustc`)
- build tools (`build-essential`)
- `git`
- `curl`

### Quick prerequisite install (Ubuntu / WSL)

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

## 2) Canonical Install Path

Source-checkout bootstrap is the canonical full-runtime GA path.

Estimated time:

- warm network/cache: 5-10 minutes
- fresh host: 10-20 minutes

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
npm run bootstrap
```

`npm run bootstrap` calls the repo bootstrap flow and:

1. creates `.env` from template if missing
2. generates `MEMPHIS_API_TOKEN` and `MEMPHIS_VAULT_PEPPER`
3. ensures the local agent profile exists
4. auto-detects local Ollama models when available
5. installs npm dependencies when needed
6. builds Rust and TypeScript
7. prepares runtime/service wiring
8. prints the next step: `memphis init`

Bootstrap is technical install/build only. It does not silently create
meaningful identity, vault, or first-run state.

### Controlled first-run

After bootstrap:

```bash
memphis init
```

`memphis init` is the canonical operator-first step. It owns:

- operator passphrase enrollment
- vault initialization
- first-state mode selection
- preview and confirmation of first chain writes
- first-run status recording

### Optional user service

If `systemd --user` is available in the host shell:

```bash
memphis service install
memphis service restart
systemctl --user status memphis.service
```

If `systemd --user` is unavailable:

```bash
npm run dev
```

### Optional installer audit

To verify the source-checkout installer contract without mutating the host:

```bash
bash ./scripts/install.sh --check-only --json
```

---

## 3) Manual Fallback

Use this only when you intentionally want a more manual source-checkout path.
It is a bounded fallback, not the primary operator story.

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
npm install
npm run build
npm link
cp .env.example .env
memphis init
```

If you use the manual path, prefer reviewing [.env.example](../.env.example)
before editing runtime settings.

---

## 4) Post-Install Verification

Run these checks from the repository root after `memphis init`:

```bash
memphis init status --json
memphis doctor --json
memphis health --json
memphis guide
```

Expected outcomes:

- `init status` shows first-run is complete
- `doctor` returns JSON with `"ok": true` on a healthy configured machine
- `health` reports `runtimeStatus: "healthy"`
- `guide` matches the same `bootstrap -> init -> health -> tui` story

If the runtime is degraded but repairable:

```bash
memphis repair runtime
memphis doctor --json
```

---

## 5) First Runtime Configuration

Keep `.env` focused on non-secret runtime settings. Provider credentials and bot
tokens should go through the vault-backed flows after `init`.

Examples:

```bash
memphis provider add minimax --api-key sk-xxx
memphis provider add deepseek --api-key sk-xxx
memphis provider add glm --api-key sk-xxx
memphis telegram configure --bot-token <token> --allowed-user-ids <user_id>
```

Default localhost split:

- runtime/API HTTP: `127.0.0.1:3000`
- external MCP-over-HTTP: `127.0.0.1:3001`

For full configuration details, see [CONFIGURATION.md](./CONFIGURATION.md).

---

## 6) WSL Notes

- use WSL2, not WSL1
- use Ubuntu
- keep the repo under the Linux filesystem, not `/mnt/c/...`
- if command resolution fails after `npm link`, run:

```bash
hash -r
which memphis
```

---

## 7) Troubleshooting

### `node -v` is below 22

Reinstall Node.js from NodeSource 22.x and reopen the shell.

### `cargo` or `rustc` not found

```bash
source "$HOME/.cargo/env"
```

Persist it in your shell profile:

```bash
echo 'source "$HOME/.cargo/env"' >> ~/.bashrc
```

### Native build fails

```bash
sudo apt-get install -y build-essential pkg-config libssl-dev
```

### `memphis` command not found after `npm link`

```bash
npm bin -g
echo "$PATH"
which memphis
```

### Need a true blank slate before reinstall

Use [RE-INSTALL.md](./RE-INSTALL.md).

---

## 8) What To Do Next

- [GUIDE-FIRST-BOOTSTRAP.md](./GUIDE-FIRST-BOOTSTRAP.md) for the canonical
  `bootstrap -> init` flow
- [CLEAN-INSTALL.md](./CLEAN-INSTALL.md) for the shortest source-first operator
  path
- [CONFIGURATION.md](./CONFIGURATION.md) for provider and runtime settings
- [OPERATIONS-MANUAL.md](./OPERATIONS-MANUAL.md) for service and production
