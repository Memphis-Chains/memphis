# Memphis Re-Installation Guide

Clean uninstall and fresh reinstall for the active Memphis `v1.x` operator flow.

This document is advisory only. The canonical full-runtime operator path remains
source checkout plus bootstrap as documented in `README.md`,
`docs/GETTING-STARTED.md`, and `docs/INSTALLATION.md`.

---

## 1) Prerequisites

Before reinstalling, make sure the host still has:

- Node.js 22 LTS or newer
- npm
- Rust stable (`cargo`, `rustc`)
- git
- build tools (`build-essential`, `pkg-config`, `libssl-dev`)

Quick check:

```bash
node --version
npm --version
cargo --version
rustc --version
git --version
```

---

## 2) Clean Uninstall

### Stop Memphis processes

```bash
pkill -9 -f memphis 2>/dev/null || true
pkill -9 -f "memphis-*" 2>/dev/null || true
```

If you use a systemd user service from a normal host shell:

```bash
systemctl --user stop memphis.service 2>/dev/null || true
systemctl --user disable memphis.service 2>/dev/null || true
rm -f ~/.config/systemd/user/memphis.service 2>/dev/null || true
systemctl --user daemon-reload 2>/dev/null || true
```

### Remove global CLI link or package

```bash
npm uninstall -g @memphis-chains/memphis 2>/dev/null || true
npm uninstall -g memphis 2>/dev/null || true
hash -r 2>/dev/null || true
which memphis 2>/dev/null || echo "memphis removed from PATH"
```

### Remove source checkout

Adjust the path if your checkout lives somewhere else:

```bash
rm -rf ~/memphis 2>/dev/null || true
```

### Remove runtime state

Memphis stores runtime state under the active `HOME` used during install.
For a normal host shell that usually means:

```bash
rm -rf ~/.memphis 2>/dev/null || true
rm -rf ~/.config/memphis 2>/dev/null || true
rm -rf ~/.local/share/memphis 2>/dev/null || true
rm -rf ~/.local/state/memphis 2>/dev/null || true
```

If you previously ran Memphis from a confined shell or custom home, also remove
the Memphis runtime directory under that environment's `HOME`.

### Optional cache cleanup

```bash
npm cache clean --force 2>/dev/null || true
```

### Verify uninstall

```bash
which memphis 2>/dev/null && echo "memphis still on PATH" || echo "memphis not on PATH"
[ -d ~/memphis ] && echo "~/memphis still exists" || echo "~/memphis removed"
[ -d ~/.memphis ] && echo "~/.memphis still exists" || echo "~/.memphis removed"
pgrep -f memphis >/dev/null && echo "memphis processes still running" || echo "no memphis processes"
```

---

## 3) Fresh Install

Use the canonical source-first path:

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
npm run bootstrap
memphis init
```

`bootstrap` is technical install/build only. It prepares `.env`, generates
runtime secrets, builds Rust and TypeScript, and wires the local runtime.
Meaningful first-run state is still owned by `memphis init`.

If systemd user services are available and you want a background runtime:

```bash
memphis service install
memphis service restart
```

If systemd is unavailable:

```bash
npm run dev
```

For the full supported install story, see [INSTALLATION.md](./INSTALLATION.md).
For the short operator path, see [CLEAN-INSTALL.md](./CLEAN-INSTALL.md).

---

## 4) Verification After Reinstall

Run these from the fresh checkout:

```bash
memphis init status --json
memphis doctor --json
memphis health --json
memphis tui
```

What you want to see:

- `init status` shows first-run is complete
- `doctor` returns `ok=true` on a healthy configured machine
- `health` reports `runtimeStatus: "healthy"`
- the TUI opens and shows the same runtime story as `guide`

If the runtime is degraded but repairable:

```bash
memphis repair runtime
memphis doctor --json
```

---

## 5) Troubleshooting

### `memphis` command not found

```bash
npm uninstall -g @memphis-chains/memphis 2>/dev/null || true
cd ~/memphis
npm link
hash -r
which memphis
```

### Rust toolchain missing

```bash
source "$HOME/.cargo/env"
cargo --version
rustc --version
```

### Native build fails

```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev
```

### Doctor reports degraded runtime after reinstall

```bash
memphis repair runtime
memphis doctor --json
```

---

## Archived Note

OpenClaw is deprecated/downstream only and is not part of the active Memphis
`v1.x` reinstall path.

This repository does not provide a supported OpenClaw plugin install path or a
publishable plugin artifact as part of the Memphis operator workflow.

If you are maintaining a historical downstream OpenClaw fork, treat that work
as downstream-specific validation outside the Memphis `v1.x` reinstall path.
