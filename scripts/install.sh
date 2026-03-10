#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_NAME="$(basename "$0")"
DEFAULT_REPO_URL="https://github.com/Memphis-Chains/memphis-v4.git"

log() { echo "[install] $*"; }
warn() { echo "[install][warn] $*" >&2; }
fail() { echo "[install][fail] $*" >&2; exit 1; }

trap 'fail "bootstrap failed near line ${LINENO}. Re-run with: bash -x scripts/install.sh"' ERR

have() { command -v "$1" >/dev/null 2>&1; }

need_sudo() {
  [[ "$(id -u)" -ne 0 ]]
}

run_sudo() {
  if need_sudo; then
    if ! have sudo; then
      fail "sudo is required to install system packages. Install sudo or run as root."
    fi
    sudo "$@"
  else
    "$@"
  fi
}

detect_os() {
  local uname_s
  uname_s="$(uname -s)"

  if [[ "$uname_s" == "Darwin" ]]; then
    OS_FAMILY="macos"
    return
  fi

  if [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    source /etc/os-release
    case "${ID:-}" in
      ubuntu|debian)
        OS_FAMILY="debian"
        ;;
      *)
        case "${ID_LIKE:-}" in
          *debian*) OS_FAMILY="debian" ;;
          *) fail "Unsupported Linux distro: ID=${ID:-unknown}, ID_LIKE=${ID_LIKE:-unknown}. Supported: Ubuntu/Debian." ;;
        esac
        ;;
    esac
    return
  fi

  fail "Unsupported OS. Supported: Ubuntu/Debian and macOS."
}

ensure_build_essentials() {
  log "ensuring build dependencies"

  if [[ "$OS_FAMILY" == "debian" ]]; then
    run_sudo apt-get update -y
    run_sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
      build-essential \
      cmake \
      pkg-config \
      git \
      curl \
      ca-certificates
  else
    have brew || fail "Homebrew not found. Install Homebrew first: https://brew.sh"
    brew update
    brew install cmake pkg-config git curl || true
  fi
}

ensure_rust() {
  if have cargo; then
    log "rust already present: $(cargo --version)"
    return
  fi

  log "installing rust via rustup"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

  # shellcheck source=/dev/null
  source "$HOME/.cargo/env"
  have cargo || fail "Rust installation failed: cargo not found after rustup install."
  log "rust installed: $(cargo --version)"
}

ensure_node() {
  local node_major

  if have node; then
    node_major="$(node -p "process.versions.node.split('.')[0]")"
    if [[ "$node_major" -ge 20 ]]; then
      log "node already present: $(node --version)"
      return
    fi
    warn "node $(node --version) detected (<20). Upgrading to Node 20+."
  else
    log "node not found; installing Node 20+"
  fi

  if [[ "$OS_FAMILY" == "macos" ]]; then
    have brew || fail "Homebrew not found. Install Homebrew first: https://brew.sh"
    brew install node@20 || true
    if have brew; then
      local brew_prefix
      brew_prefix="$(brew --prefix node@20 2>/dev/null || true)"
      if [[ -n "$brew_prefix" && -d "$brew_prefix/bin" ]]; then
        export PATH="$brew_prefix/bin:$PATH"
      fi
    fi
  else
    if have apt-get; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | run_sudo -E bash -
      run_sudo apt-get install -y nodejs
    fi
  fi

  if ! have node || ! have npm; then
    # fallback to nvm (no sudo path)
    log "falling back to nvm install"
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    fi
    # shellcheck source=/dev/null
    source "$NVM_DIR/nvm.sh"
    nvm install 20
    nvm use 20
  fi

  have node || fail "Node installation failed: node binary not found."
  have npm || fail "Node installation failed: npm binary not found."

  node_major="$(node -p "process.versions.node.split('.')[0]")"
  [[ "$node_major" -ge 20 ]] || fail "Node version must be >=20, found $(node --version)."
  log "node ready: $(node --version), npm: $(npm --version)"
}

ensure_repo() {
  local candidate_root
  candidate_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  if [[ -f "$candidate_root/package.json" && -f "$candidate_root/.env.example" ]]; then
    ROOT_DIR="$candidate_root"
    return
  fi

  REPO_URL="${MEMPHIS_REPO_URL:-$DEFAULT_REPO_URL}"
  ROOT_DIR="${MEMPHIS_REPO_DIR:-$PWD/memphis-v4}"

  if [[ -d "$ROOT_DIR/.git" ]]; then
    log "using existing repository at $ROOT_DIR"
  elif [[ -d "$ROOT_DIR" && -n "$(ls -A "$ROOT_DIR" 2>/dev/null || true)" ]]; then
    fail "target directory exists and is not empty: $ROOT_DIR (set MEMPHIS_REPO_DIR or clean the directory)"
  else
    log "cloning repository: $REPO_URL -> $ROOT_DIR"
    git clone "$REPO_URL" "$ROOT_DIR"
  fi

  [[ -f "$ROOT_DIR/package.json" ]] || fail "Invalid repository at $ROOT_DIR: package.json missing."
}

run_memphis_doctor() {
  local out

  if have memphis; then
    log "running memphis doctor"
    out="$(memphis doctor --json 2>/dev/null || true)"
  elif have memphis-v4; then
    log "running memphis-v4 doctor"
    out="$(memphis-v4 doctor --json 2>/dev/null || true)"
  else
    log "running local CLI doctor"
    out="$(npm run -s cli -- doctor --json 2>/dev/null || true)"
  fi

  [[ -n "$out" ]] || fail "doctor command produced no output. Run manually: npm run -s cli -- doctor --json"
  echo "$out"

  local doctor_ok
  doctor_ok="$(printf '%s' "$out" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(String(j.ok===true));}catch{process.stdout.write('false')}})")"
  [[ "$doctor_ok" == "true" ]] || fail "doctor reported failing checks. Review output above and fix environment variables in .env."
}

main() {
  log "${SCRIPT_NAME} starting"

  detect_os
  log "detected OS: $OS_FAMILY"

  ensure_build_essentials
  ensure_node
  ensure_rust
  ensure_repo

  cd "$ROOT_DIR"
  log "working directory: $ROOT_DIR"

  if [[ ! -f .env ]]; then
    cp .env.example .env
    log "created .env from .env.example"
  else
    log ".env already exists, leaving it unchanged"
  fi

  log "installing npm dependencies"
  npm install

  log "building project"
  npm run -s build

  log "running final doctor check"
  run_memphis_doctor

  log "bootstrap complete. You can now run: npx memphis-v4 doctor --json"
}

main "$@"
