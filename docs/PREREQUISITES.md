# Memphis v5 Prerequisites ✅

Before installing Memphis v5, verify your host meets the minimum baseline below.

Related docs: [OLLAMA-SETUP.md](./OLLAMA-SETUP.md) · [POST-INSTALLATION.md](./POST-INSTALLATION.md) · [PLATFORM-NOTES.md](./PLATFORM-NOTES.md)

---

## 1) Hardware Requirements

| Profile | RAM | CPU | Disk | Recommended Use |
|---|---:|---:|---:|---|
| Minimum | 8 GB | 4 cores | 20 GB free SSD | CLI + basic workflows |
| Recommended | 16 GB | 8 cores | 50 GB free SSD | Daily cognitive workflows + Ollama embeddings |
| Production | 32+ GB | 12+ cores | 100+ GB NVMe | Heavy indexing, concurrent tasks, large local models |

⚠️ If you run Ollama models locally, memory pressure is the #1 performance bottleneck.

---

## 2) Software Requirements

### Required
- ✅ **Node.js**: `>=18.0.0` (recommended `24.x`)
- ✅ **npm**: `>=9.0.0`
- ✅ **Rust toolchain**: stable (rustc + cargo)
- ✅ **Git**: recent 2.x
- ✅ **Bash**, **curl**, **python3**

### Optional but recommended
- Ollama runtime for local embeddings/chat
- `jq` for scripting and diagnostics
- build toolchain packages (`build-essential` / equivalent)

---

## 3) OS Compatibility Matrix

| OS | Status | Notes |
|---|---|---|
| Ubuntu 20.04+ | ✅ Supported | Best-supported Linux target |
| Debian 11+ | ✅ Supported | Use apt build dependencies |
| Fedora 35+ | ✅ Supported | Use dnf group install tools |
| WSL2 (Ubuntu/Debian) | ✅ Supported | Prefer Linux-side install, avoid Windows path mixing |
| RHEL 9+ | ⚠️ Compatible with notes | Use EPEL/dev tools as needed |
| macOS | ⚠️ Partial / future-focused | Works for dev flows, some runtime differences |
| Windows native | ❌ Not primary target | Use WSL2 for now |

For platform specifics: [PLATFORM-NOTES.md](./PLATFORM-NOTES.md)

---

## 4) System Dependencies

### Ubuntu / Debian
```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  pkg-config \
  libssl-dev \
  git \
  curl \
  wget \
  ca-certificates \
  python3 \
  python3-pip \
  jq
```

### Fedora / RHEL
```bash
sudo dnf -y groupinstall "Development Tools"
sudo dnf install -y \
  openssl-devel \
  pkgconf-pkg-config \
  git \
  curl \
  wget \
  ca-certificates \
  python3 \
  python3-pip \
  jq
```

---

## 5) Version Compatibility Table

| Component | Minimum | Recommended | Verification |
|---|---:|---:|---|
| Node.js | 18.x | 24.x | `node --version` |
| npm | 9.x | 10.x+ | `npm --version` |
| Rust | stable | latest stable | `rustc --version` |
| Cargo | stable | latest stable | `cargo --version` |
| Git | 2.30+ | latest | `git --version` |
| Ollama (optional) | 0.1+ | latest | `ollama --version` |

---

## 6) Verification Commands

Run all checks:

```bash
set -e
node --version
npm --version
rustc --version
cargo --version
git --version
python3 --version
curl --version | head -n 1
```

Expected output pattern:

```text
v24.x.x
10.x.x
rustc 1.xx.x
cargo 1.xx.x
git version 2.xx.x
Python 3.x.x
curl 8.x.x (...)
```

### Quick health precheck

```bash
bash scripts/verify-installation.sh
```

If checks fail, see [TROUBLESHOOTING-DECISION-TREE.md](./TROUBLESHOOTING-DECISION-TREE.md).
