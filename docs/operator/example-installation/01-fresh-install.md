# 01 — Fresh install on a clean Ubuntu 24.04 box

> ⚠️ **SYNTHETIC EXAMPLE** — output strings below are reconstructed from
> reading `scripts/install.sh` source code, NOT captured from a real
> install run. Format and exact wording will differ on your machine. The
> structure (steps, commands, expected order) is correct; verbatim text
> and timings are illustrative.
>
> A real Docker-captured walkthrough is on the backlog (separate sprint)
> — when it lands, this file will be replaced with verbatim output.

> Reference: clean Ubuntu 24.04 LTS, fresh user account, sudo access,
> no Memphis prerequisites pre-installed. Times are from Intel i3-2120
> (2011 CPU, no GPU); modern hardware is 2–10× faster.

## Setup

```
$ uname -a
Linux example-host 6.8.0-31-generic #31-Ubuntu SMP PREEMPT_DYNAMIC x86_64 GNU/Linux

$ whoami
operator

$ sudo -v
[sudo] password for operator: ********

$ pwd
/home/operator
```

## One-liner install

```
$ time bash <(curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh)

[memphis-install] OS: linux  PLATFORM: linux
[memphis-install] Missing required tools: git curl
Install missing core tools now? [y/N]: y
[memphis-install] (apt-get update + install git curl) → ~25s

[memphis-install] Build toolchain not fully present — installing build essentials
(apt-get install build-essential pkg-config libssl-dev python3) → ~95s

[memphis-install] Node.js not found; Memphis requires v22+
Install/upgrade Node.js to v22+ now? [y/N]: y
(NodeSource setup_22.x + apt-get install nodejs) → ~40s
[memphis-install] Node.js ready: v22.x.x, npm: 10.x.x

[memphis-install] Rust toolchain not found (rustc/cargo).
Install Rust stable via rustup now? [y/N]: y
(curl https://sh.rustup.rs | sh -s -- -y) → ~120s
[memphis-install] Rust ready: rustc 1.84.x (stable)

[memphis-install] Ollama not found — required for local embeddings...
Install Ollama now via the official script? [y/N]: y
(curl https://ollama.com/install.sh | sh) → ~30s
[memphis-install] Pulling Ollama model: nomic-embed-text → ~75s
[memphis-install] Pulling Ollama model: cogito:3b → ~180s

[memphis-install] Cloning Memphis into /home/operator/memphis
(git clone) → ~12s

[memphis-install] npm ci  → ~85s
[memphis-install] npm run build → ~210s
[memphis-install] npm link → ~3s

[memphis-install] Install complete.
[memphis-install] Run: memphis init

real    14m22s
user    8m17s
sys     1m45s
```

**Total elapsed:** ~14 minutes on the reference box. **Modern hardware**
(CPU since 2018, NVMe, 16 GB RAM): expect 4–6 minutes.

## Verify install

```
$ memphis --version
@memphis-chains/memphis v1.3.0

$ which memphis
/usr/lib/node_modules/.bin/memphis -> /home/operator/memphis/bin/memphis.js

$ memphis --help
Memphis — sovereign cognitive runtime
Usage: memphis <command> [options]

Commands:
  init         First-run setup
  health       Runtime health check
  doctor       Pre-flight diagnosis
  service      systemd integration
  tui          Native terminal cockpit
  vault        Vault operations
  chat         Send a chat turn
  ...
```

## What's now on disk

```
/home/operator/memphis/        ← repo checkout (~700 MB after build)
├── crates/                    ← 7 Rust crates
├── src/                       ← 25+ TS modules
├── node_modules/              ← npm deps (~300 MB)
├── target/                    ← cargo build artifacts (~250 MB)
├── dist/                      ← compiled TS
└── bin/memphis.js             ← CLI entry

/home/operator/.memphis/       ← does NOT exist yet (created by memphis init)
/home/operator/.config/memphis/ ← does NOT exist yet
```

**Critical:** Memphis is stateless after install. No vault, no identity,
no chains exist until you run `memphis init`. If you `rm -rf
/home/operator/memphis/` right now, you've lost nothing irrecoverable.

Continue to [`02-first-run.md`](./02-first-run.md).
