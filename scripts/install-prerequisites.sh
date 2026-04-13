#!/usr/bin/env bash
# install-prerequisites.sh
# Installs baseline dependencies for Memphis on Ubuntu/Debian/Fedora/WSL.

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info(){ echo -e "${YELLOW}[INFO]${NC} $*"; }
log_ok(){ echo -e "${GREEN}[OK]${NC} $*"; }
log_err(){ echo -e "${RED}[ERR]${NC} $*"; }

trap 'log_err "Installation failed at line $LINENO"; exit 1' ERR

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { log_err "Missing required command: $1"; exit 2; }
}

detect_os() {
  if grep -qi microsoft /proc/version 2>/dev/null; then
    IS_WSL=1
  else
    IS_WSL=0
  fi

  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_VER="${VERSION_ID:-unknown}"
  else
    OS_ID="unknown"
    OS_VER="unknown"
  fi

  log_info "Detected OS: ${OS_ID} ${OS_VER} (WSL=${IS_WSL})"
}

install_base_apt() {
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential pkg-config libssl-dev \
    git curl wget ca-certificates \
    python3 python3-pip jq
}

install_base_dnf() {
  sudo dnf -y groupinstall "Development Tools"
  sudo dnf install -y \
    openssl-devel pkgconf-pkg-config \
    git curl wget ca-certificates \
    python3 python3-pip jq
}

install_node() {
  if command -v node >/dev/null 2>&1; then
    log_ok "Node already installed: $(node --version)"
    return
  fi

  log_info "Installing Node.js via NodeSource (22.x)"
  if [[ "$OS_ID" == "ubuntu" || "$OS_ID" == "debian" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif [[ "$OS_ID" == "fedora" || "$OS_ID" == "rhel" ]]; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
    sudo dnf install -y nodejs
  else
    log_err "Unsupported OS for automatic Node install: $OS_ID"
    exit 3
  fi
}

install_rust() {
  if command -v rustc >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1; then
    log_ok "Rust already installed: $(rustc --version)"
    return
  fi

  log_info "Installing Rust toolchain via rustup"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
}

install_ollama() {
  if command -v ollama >/dev/null 2>&1; then
    log_ok "Ollama already installed: $(ollama --version 2>&1 | head -n1)"
    return
  fi

  log_info "Installing Ollama (official installer)"
  curl -fsSL https://ollama.com/install.sh | sh
}

install_ollama_models() {
  if ! command -v ollama >/dev/null 2>&1; then
    log_err "Ollama not available; skipping model pulls"
    return
  fi

  # Ensure the daemon is reachable. The official installer usually starts
  # it, but on headless systems it may need a nudge.
  if ! ollama list >/dev/null 2>&1; then
    log_info "Starting ollama daemon in background"
    (ollama serve >/dev/null 2>&1 &) || true
    sleep 3
  fi

  for model in nomic-embed-text cogito:3b; do
    if ollama list 2>/dev/null | awk '{print $1}' | grep -Fxq "$model"; then
      log_ok "Ollama model already present: $model"
      continue
    fi
    log_info "Pulling Ollama model: $model"
    if ! ollama pull "$model"; then
      log_err "Failed to pull $model (continuing)"
    fi
  done
}

verify() {
  local failed=0
  for cmd in git curl python3 node npm rustc cargo ollama; do
    if command -v "$cmd" >/dev/null 2>&1; then
      log_ok "$cmd: $("$cmd" --version 2>/dev/null | head -n1 || true)"
    else
      log_err "$cmd missing"
      failed=1
    fi
  done

  if command -v ollama >/dev/null 2>&1; then
    for model in nomic-embed-text cogito:3b; do
      if ollama list 2>/dev/null | awk '{print $1}' | grep -Fxq "$model"; then
        log_ok "ollama model present: $model"
      else
        log_err "ollama model missing: $model"
        failed=1
      fi
    done
  fi

  if (( failed )); then
    log_err "Verification failed"
    exit 4
  fi

  log_ok "All prerequisites installed successfully"
}

main() {
  require_cmd sudo
  require_cmd curl
  detect_os

  case "$OS_ID" in
    ubuntu|debian)
      install_base_apt
      ;;
    fedora|rhel)
      install_base_dnf
      ;;
    *)
      log_err "Unsupported OS: $OS_ID"
      exit 5
      ;;
  esac

  install_node
  install_rust
  install_ollama
  install_ollama_models
  verify
}

main "$@"
