# Memphis Install Guide (EN)

> Canonical install guide for Memphis on a clean PC.
> Covers Linux, macOS, WSL2. Windows users: install WSL2 first, then follow the Linux path.
> Polish version: [`install.pl.md`](./install.pl.md).

---

## TL;DR — One-liner

If you trust the upstream installer:

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash
```

The installer is **idempotent** and **interactive** — it will confirm before installing system packages. To audit before running:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh) --check-only --json
```

After install:

```bash
memphis init             # passphrase + vault + identity (interactive)
memphis doctor           # verify everything is healthy
memphis service install  # systemd user service
memphis service start    # start the runtime
memphis tui              # open the native terminal cockpit
```

That's it. If anything goes wrong, see [`debug.en.md`](./debug.en.md).

---

## Prerequisites

| Requirement | Why | Auto-installed by `install.sh`? |
|---|---|---|
| Linux / macOS / WSL2 | Native Windows shells unsupported | n/a |
| `git` | Repo clone + version pinning | yes (apt/dnf/brew/pacman/zypper) |
| `curl` or `wget` or `python3` | Downloader | yes |
| `sudo` (or root) | System package install | required |
| Node.js ≥ v22 | Memphis runtime | yes (NodeSource on Linux, brew on macOS) |
| Rust stable | NAPI bridge + crates | yes (rustup) |
| Build toolchain (cc, make, pkg-config, openssl, python3) | better-sqlite3 + NAPI native modules | yes |
| Ollama (optional but recommended) | Local LLM + embeddings | yes if you confirm |

**Disk:** ~2 GB for Memphis + dependencies. **RAM:** 2 GB minimum, 8 GB recommended. **CPU:** any x86_64 from 2013+ (AVX). The sovereign-RAG stack is proven on Intel i3-2120 (2011) without GPU and without internet access — that's the lower bound.

---

## Manual install (alternative to one-liner)

If you prefer step-by-step control:

```bash
# 1. Clone
git clone https://github.com/Memphis-Chains/memphis.git ~/memphis
cd ~/memphis

# 2. System dependencies (Ubuntu/Debian shown; adapt for other distros)
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev python3 git curl

# 3. Node 22 (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 4. Rust stable
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
source "$HOME/.cargo/env"

# 5. Optional: Ollama (for local LLM + embeddings)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull cogito:3b
ollama pull nomic-embed-text

# 6. Build Memphis
npm ci
npm run build

# 7. Link CLI globally
npm link

# 8. Verify install
memphis --version
```

For a fully isolated build environment, see [`docs/operator/CLEAN-INSTALL.md`](./CLEAN-INSTALL.md).

---

## First run

Memphis is **stateless after install** — no vault, no identity, no chains exist until you run `memphis init`.

```bash
memphis init
```

Interactive prompts:
1. **Operator passphrase** — used to elevate to tier 2 (write/execute tools). Choose a strong passphrase; you'll be asked for it on every elevation. Memphis never logs it.
2. **Vault passphrase** — encrypts your secrets vault (AES-256-GCM + Argon2id KDF). Different from the operator passphrase.
3. **Recovery question + answer** — used if you ever lose the vault passphrase. Write both down somewhere safe. The answer is hashed; we cannot recover the original.
4. **Agent name + owner name** — vanity, used in chain entries.

After `memphis init` completes:

```bash
memphis doctor              # full health check
memphis health --json       # machine-readable health
memphis service install     # install systemd user service (Linux)
memphis service start       # start the runtime daemon
memphis service status      # confirm running
```

Verify the daemon is reachable:

```bash
memphis health
# expects: status=ok, vault=initialized, chains=ready
```

---

## Verification

Run all of these green before declaring install complete:

```bash
memphis health                              # daemon reachable
memphis doctor                              # all checks pass
memphis vault list                          # vault unlocks (will prompt for passphrase)
memphis journal "First memory entry"        # chain append works
memphis recall "first memory"               # semantic search returns the entry
memphis chat --input "Hello, Memphis."      # local-fallback or Ollama replies
memphis tui --check-only --json             # TUI cockpit boot-test
```

If all green, your installation is **production-ready for first test**.

---

## Common errors → fix

| Error | Diagnosis | Fix |
|---|---|---|
| `Node.js v22+ required, found v20` | Outdated Node | Re-run installer; or `nvm install 22 && nvm use 22` |
| `rustc not found` | Rust not in PATH | `source $HOME/.cargo/env` (add to `~/.bashrc`) |
| `better-sqlite3` install fails | Missing build toolchain | `sudo apt-get install build-essential python3` |
| `Cannot find module '@memphis-chains/memphis'` | `npm link` not run | `cd ~/memphis && npm link` |
| `memphis: command not found` after npm link | Linker path | Add `$(npm prefix -g)/bin` to PATH |
| `vault unlock failed: invalid passphrase` | Typo or wrong passphrase | Use recovery question/answer if forgotten |
| `Connection refused on :3000` | Daemon not started | `memphis service start` |
| `Ollama unreachable` | Ollama not running | `ollama serve &` (or skip — local-fallback handles it) |
| `Chain corrupt` | Disk error mid-write | `memphis repair runtime --fix` |

For a full troubleshooting tree, see [`debug.en.md`](./debug.en.md).

---

## Uninstall

```bash
memphis service stop
memphis service uninstall
npm unlink -g @memphis-chains/memphis
rm -rf ~/memphis ~/.memphis ~/.config/memphis
```

This removes the runtime + state. To preserve chains for archival, copy `~/.memphis/chains/` somewhere safe before `rm -rf`.

---

## Related docs

- **First steps:** [`example-installation/`](./example-installation/)
- **Debug playbook:** [`debug.en.md`](./debug.en.md)
- **CLI reference:** [`CLI-REFERENCE.md`](./CLI-REFERENCE.md)
- **Vault CLI:** [`VAULT-CLI.md`](./VAULT-CLI.md)
- **Upgrade guide:** [`UPGRADE.md`](./UPGRADE.md)
- **Architecture (developers):** [`../dev/CANONICAL-ARCHITECTURE.md`](../dev/CANONICAL-ARCHITECTURE.md)

---

_Last verified: 2026-04-19 against `scripts/install.sh` + `scripts/bootstrap.sh` on Memphis v1.3.0._
