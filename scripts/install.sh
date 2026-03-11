#!/usr/bin/env bash
# get.memphis.ai - Memphis v5 installer
set -Eeuo pipefail

REPO_URL="${MEMPHIS_REPO_URL:-https://github.com/Memphis-Chains/memphis-v5.git}"
INSTALL_BASE="${MEMPHIS_INSTALL_DIR:-$HOME/.memphis}"
TARGET_DIR="${MEMPHIS_TARGET_DIR:-$INSTALL_BASE/memphis-v5}"
ASSUME_YES="${MEMPHIS_YES:-0}"
SKIP_PLUGIN="${MEMPHIS_SKIP_OPENCLOW_PLUGIN:-0}"

OS=""
PLATFORM=""

log() { echo "[memphis-install] $*"; }
warn() { echo "[memphis-install][warn] $*" >&2; }
fail() { echo "[memphis-install][error] $*" >&2; exit 1; }

trap 'fail "Installer failed near line ${LINENO}. Re-run with: bash -x scripts/install.sh"' ERR

have() { command -v "$1" >/dev/null 2>&1; }

confirm() {
  local prompt="$1"
  if [[ "$ASSUME_YES" == "1" || "$ASSUME_YES" == "true" ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    fail "$prompt (non-interactive mode). Re-run with MEMPHIS_YES=1 to auto-consent."
  fi
  read -r -p "$prompt [y/N]: " ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

need_sudo() {
  [[ "$(id -u)" -ne 0 ]]
}

run_sudo() {
  if need_sudo; then
    if ! have sudo; then
      fail "sudo is required to install dependencies. Install sudo or run as root."
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
    OS="macos"
    PLATFORM="macos"
    return
  fi

  if [[ "$uname_s" == "Linux" ]]; then
    OS="linux"
    if grep -qi microsoft /proc/version 2>/dev/null; then
      PLATFORM="wsl"
    else
      PLATFORM="linux"
    fi
    return
  fi

  case "$uname_s" in
    MINGW*|MSYS*|CYGWIN*)
      OS="windows"
      PLATFORM="windows"
      fail "Native Windows shell detected. Please run this installer in WSL (Ubuntu) or Linux/macOS."
      ;;
    *)
      fail "Unsupported OS: $uname_s"
      ;;
  esac
}

ensure_core_tools() {
  local missing=()
  for t in git curl; do
    have "$t" || missing+=("$t")
  done

  if [[ "${#missing[@]}" -eq 0 ]]; then
    return
  fi

  warn "Missing required tools: ${missing[*]}"
  confirm "Install missing core tools now?" || fail "Cannot continue without: ${missing[*]}"

  if [[ "$OS" == "macos" ]]; then
    have brew || fail "Homebrew is required on macOS. Install it first: https://brew.sh"
    brew update
    brew install "${missing[@]}"
    return
  fi

  if have apt-get; then
    run_sudo apt-get update -y
    run_sudo apt-get install -y "${missing[@]}"
  elif have dnf; then
    run_sudo dnf install -y "${missing[@]}"
  elif have yum; then
    run_sudo yum install -y "${missing[@]}"
  elif have pacman; then
    run_sudo pacman -Sy --noconfirm "${missing[@]}"
  elif have zypper; then
    run_sudo zypper install -y "${missing[@]}"
  else
    fail "No supported package manager found for installing: ${missing[*]}"
  fi
}

ensure_node24() {
  local major=""
  if have node; then
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [[ "$major" -ge 24 ]]; then
      log "Node.js OK: $(node -v)"
      have npm || fail "npm is missing even though node exists."
      return
    fi
    warn "Node.js $(node -v) detected; Memphis requires v24+"
  else
    warn "Node.js not found; Memphis requires v24+"
  fi

  confirm "Install/upgrade Node.js to v24+ now?" || fail "Node.js v24+ is required."

  if [[ "$OS" == "macos" ]]; then
    have brew || fail "Homebrew is required to install Node.js on macOS."
    brew install node@24 || brew upgrade node@24 || true
    local np
    np="$(brew --prefix node@24 2>/dev/null || true)"
    if [[ -n "$np" && -d "$np/bin" ]]; then
      export PATH="$np/bin:$PATH"
    fi
  else
    if have apt-get; then
      curl -fsSL https://deb.nodesource.com/setup_24.x | run_sudo -E bash -
      run_sudo apt-get install -y nodejs
    elif have dnf; then
      run_sudo dnf module enable -y nodejs:24 || true
      run_sudo dnf install -y nodejs
    elif have yum; then
      curl -fsSL https://rpm.nodesource.com/setup_24.x | run_sudo bash -
      run_sudo yum install -y nodejs
    elif have pacman; then
      run_sudo pacman -Sy --noconfirm nodejs npm
    elif have zypper; then
      run_sudo zypper install -y nodejs24 npm24 || run_sudo zypper install -y nodejs npm
    else
      fail "Unsupported package manager for Node.js auto-install."
    fi
  fi

  have node || fail "Node.js installation failed (node not found)."
  have npm || fail "Node.js installation failed (npm not found)."
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" -ge 24 ]] || fail "Node.js v24+ required, found $(node -v)"
  log "Node.js ready: $(node -v), npm: $(npm -v)"
}

ensure_rust_stable() {
  if have rustc && have cargo; then
    local channel
    channel="$(rustc -vV | awk -F': ' '/^release:/{print $2}')"
    log "Rust detected: $(rustc --version)"
    if [[ "$channel" == *nightly* ]]; then
      warn "Nightly Rust detected. Memphis expects stable toolchain."
      confirm "Install Rust stable toolchain now?" || fail "Rust stable is required."
      rustup toolchain install stable
      rustup default stable
    fi
    return
  fi

  warn "Rust toolchain not found (rustc/cargo)."
  confirm "Install Rust stable via rustup now?" || fail "Rust stable is required."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"

  have rustc || fail "Rust install failed: rustc not found"
  have cargo || fail "Rust install failed: cargo not found"
  log "Rust ready: $(rustc --version)"
}

resolve_repo() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local maybe_repo
  maybe_repo="$(cd "$script_dir/.." && pwd)"

  if [[ -f "$maybe_repo/package.json" ]] && grep -q '"@memphis-chains/memphis-v5"' "$maybe_repo/package.json"; then
    TARGET_DIR="$maybe_repo"
    log "Using local Memphis repository: $TARGET_DIR"
    return
  fi

  mkdir -p "$INSTALL_BASE"
  if [[ -d "$TARGET_DIR/.git" ]]; then
    log "Updating existing repo: $TARGET_DIR"
    git -C "$TARGET_DIR" fetch --all --prune
    git -C "$TARGET_DIR" pull --ff-only
  else
    if [[ -d "$TARGET_DIR" ]] && [[ -n "$(ls -A "$TARGET_DIR" 2>/dev/null || true)" ]]; then
      fail "Target directory exists and is not empty: $TARGET_DIR"
    fi
    log "Cloning Memphis v5 into $TARGET_DIR"
    git clone "$REPO_URL" "$TARGET_DIR"
  fi
}

initialize_memphis() {
  local home_dir
  home_dir="${MEMPHIS_HOME:-$HOME/.memphis}"
  mkdir -p "$home_dir"

  log "Creating first journal entry"
  if memphis reflect --save >/dev/null 2>&1; then
    log "Journal bootstrap via 'memphis reflect --save' complete"
    return
  fi

  # Fallback in case --save path changes in future CLI revisions.
  local stamp
  stamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf '{"event":"install","message":"Memphis v5 installed","timestamp":"%s"}\n' "$stamp" >> "$home_dir/first-install-journal.jsonl"
  warn "CLI journal save unavailable; wrote fallback entry: $home_dir/first-install-journal.jsonl"
}

configure_openclaw_plugin() {
  [[ "$SKIP_PLUGIN" == "1" || "$SKIP_PLUGIN" == "true" ]] && return 0

  local plugin_dir="$TARGET_DIR/openclaw-plugin"
  [[ -d "$plugin_dir" ]] || return 0

  if ! confirm "Configure optional OpenClaw plugin now?"; then
    log "Skipping OpenClaw plugin configuration"
    return
  fi

  (
    cd "$plugin_dir"
    npm install
    npm run build 2>/dev/null || true
    npm link
  )
  log "OpenClaw plugin prepared (npm link in openclaw-plugin)."
}

main() {
  log "Starting Memphis v5 installer"
  detect_os
  log "Detected platform: $PLATFORM"

  ensure_core_tools
  ensure_node24
  ensure_rust_stable
  resolve_repo

  cd "$TARGET_DIR"
  log "Installing npm dependencies"
  npm install

  log "Building Memphis v5"
  npm run build

  log "Linking global CLI (npm link)"
  npm link

  initialize_memphis

  log "Verifying installation: memphis health"
  memphis health >/dev/null

  configure_openclaw_plugin

  echo ""
  echo "✅ Memphis v5 installed!"
  echo "Run: memphis health"
  echo "Location: $TARGET_DIR"
}

main "$@"
