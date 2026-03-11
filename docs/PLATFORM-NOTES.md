# Platform Notes for Memphis v5 🖥️

Platform-specific guidance and gotchas.

Related docs: [PREREQUISITES.md](./PREREQUISITES.md) · [OLLAMA-SETUP.md](./OLLAMA-SETUP.md)

---

## Ubuntu 20.04 / 22.04 / 24.04

- ✅ Most tested target
- Install base deps via `apt-get`
- Use NodeSource or nvm for modern Node
- For Ollama GPU: ensure matching NVIDIA driver/CUDA

Gotcha:

- Older 20.04 images may ship outdated system packages; run full update first.

---

## Debian 11 / 12

- ✅ Supported
- Use `build-essential`, `pkg-config`, `libssl-dev`
- Prefer nvm if distro Node is behind

Gotcha:

- Minimal cloud images often miss `ca-certificates` and `curl`.

---

## Fedora 35+ / RHEL 9

- ✅ Supported with dnf workflow
- Install `Development Tools` group
- Use `openssl-devel` and `pkgconf-pkg-config`

Gotcha:

- SELinux policies may affect custom service paths; check audit logs if service fails.

---

## WSL2 (Windows integration)

- ✅ Recommended over Windows-native
- Install everything inside Linux distro
- Keep project in Linux filesystem (`~/...`), not `/mnt/c/...`

Gotchas:

- Port binding/firewall edge cases between Windows and WSL
- GPU acceleration support depends on host drivers + WSL GPU stack

---

## macOS (future support)

- ⚠️ Works for many dev flows, not primary production target yet
- Use Homebrew for Node/Rust/Git
- Ollama works on Apple Silicon and Intel (resource limits vary)

Gotcha:

- LaunchAgents/service management differs from systemd docs.

---

## Windows native (future support)

- ❌ Not primary path for Memphis v5 production runtime
- Recommended path: WSL2 Ubuntu + Linux instructions

---

## Cross-platform gotchas checklist

- ⚠️ PATH not reloaded after install (`source ~/.cargo/env`, new shell)
- ⚠️ Multiple Node versions causing npm mismatch
- ⚠️ Firewalls blocking local runtime ports (e.g., 11434, Memphis API)
- ⚠️ Disk too small for model cache
