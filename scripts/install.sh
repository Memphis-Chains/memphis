#!/usr/bin/env bash
# get.memphis.ai - Memphis installer
set -Eeuo pipefail

REPO_URL="${MEMPHIS_REPO_URL:-https://github.com/Memphis-Chains/memphis.git}"
INSTALL_BASE="${MEMPHIS_INSTALL_DIR:-$HOME/.memphis}"
TARGET_DIR="${MEMPHIS_TARGET_DIR:-$HOME/memphis}"
ASSUME_YES="${MEMPHIS_YES:-0}"
CHECK_ONLY=0
JSON_OUTPUT=0
SUPPORTED_NODE_MAJOR=22

OS=""
PLATFORM=""
REPO_MODE=""

log() { echo "[memphis-install] $*"; }
warn() { echo "[memphis-install][warn] $*" >&2; }
fail() { echo "[memphis-install][error] $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [--check-only] [--json] [--with-init]

Options:
  --check-only  Validate the source-checkout install contract without mutating the host
  --json        Emit machine-readable output in --check-only mode
  --with-init   After a successful install, run `memphis init` interactively so
                the operator ends the session with a vault, identity, and first-run
                record instead of just a linked CLI.
  --help        Show this help text
EOF
}

trap 'fail "Installer failed near line ${LINENO}. Re-run with: bash -x scripts/install.sh"' ERR

have() { command -v "$1" >/dev/null 2>&1; }

have_downloader() {
  have curl || have wget || have python3
}

download_to_stdout() {
  local url="$1"

  if have curl; then
    curl -fsSL "$url"
    return
  fi

  if have wget; then
    wget -qO- "$url"
    return
  fi

  if have python3; then
    python3 - "$url" <<'PY'
import sys
import urllib.request

with urllib.request.urlopen(sys.argv[1]) as response:
    sys.stdout.buffer.write(response.read())
PY
    return
  fi

  fail "No downloader available for $url (need curl, wget, or python3)"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check-only)
        CHECK_ONLY=1
        ;;
      --json)
        JSON_OUTPUT=1
        ;;
      --with-init)
        WITH_INIT=1
        ;;
      --help)
        usage
        exit 0
        ;;
      *)
        fail "Unknown option: $1"
        ;;
    esac
    shift
  done
}

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
    # Already root — strip sudo-only flags that would otherwise be exec'd as a command.
    # Currently only -E is used at call sites (e.g. `run_sudo -E bash -` for nodesource).
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -E|-H|-n) shift ;;
        *) break ;;
      esac
    done
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
  have git || missing+=("git")
  have_downloader || missing+=("curl")

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

ensure_build_essentials() {
  # better-sqlite3 and the NAPI bridge need a C/C++ toolchain + pkg-config + openssl headers.
  # Skip if cc is already present; otherwise install distro-appropriate build tools.
  if have cc && have make && have pkg-config; then
    return
  fi

  warn "Build toolchain not fully present — installing build essentials"
  if [[ "$OS" == "macos" ]]; then
    if ! xcode-select -p >/dev/null 2>&1; then
      log "Installing Xcode command line tools (may prompt for consent)"
      xcode-select --install || true
    fi
    have brew && brew install pkg-config openssl@3 || true
    return
  fi

  if have apt-get; then
    run_sudo apt-get update -y
    run_sudo apt-get install -y build-essential pkg-config libssl-dev python3 zstd
  elif have dnf; then
    run_sudo dnf groupinstall -y "Development Tools"
    run_sudo dnf install -y pkgconf-pkg-config openssl-devel python3 zstd
  elif have yum; then
    run_sudo yum groupinstall -y "Development Tools"
    run_sudo yum install -y pkgconfig openssl-devel python3 zstd
  elif have pacman; then
    run_sudo pacman -Sy --noconfirm base-devel pkgconf openssl python zstd
  elif have zypper; then
    run_sudo zypper install -y -t pattern devel_C_C++
    run_sudo zypper install -y pkg-config libopenssl-devel python3 zstd
  else
    warn "No supported package manager found for build essentials — proceeding anyway"
  fi
}

ensure_node22() {
  local major=""
  if have node; then
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [[ "$major" -ge "$SUPPORTED_NODE_MAJOR" ]]; then
      log "Node.js OK: $(node -v)"
      have npm || fail "npm is missing even though node exists."
      return
    fi
    warn "Node.js $(node -v) detected; Memphis requires v${SUPPORTED_NODE_MAJOR}+"
  else
    warn "Node.js not found; Memphis requires v${SUPPORTED_NODE_MAJOR}+"
  fi

  confirm "Install/upgrade Node.js to v${SUPPORTED_NODE_MAJOR}+ now?" || fail "Node.js v${SUPPORTED_NODE_MAJOR}+ is required."

  if [[ "$OS" == "macos" ]]; then
    have brew || fail "Homebrew is required to install Node.js on macOS."
    brew install node@22 || brew upgrade node@22 || true
    local np
    np="$(brew --prefix node@22 2>/dev/null || true)"
    if [[ -n "$np" && -d "$np/bin" ]]; then
      export PATH="$np/bin:$PATH"
    fi
  else
    if have apt-get; then
      download_to_stdout https://deb.nodesource.com/setup_22.x | run_sudo -E bash -
      run_sudo apt-get install -y nodejs
    elif have dnf; then
      run_sudo dnf module enable -y nodejs:22 || true
      run_sudo dnf install -y nodejs
    elif have yum; then
      download_to_stdout https://rpm.nodesource.com/setup_22.x | run_sudo bash -
      run_sudo yum install -y nodejs
    elif have pacman; then
      run_sudo pacman -Sy --noconfirm nodejs npm
    elif have zypper; then
      run_sudo zypper install -y nodejs22 npm22 || run_sudo zypper install -y nodejs npm
    else
      fail "Unsupported package manager for Node.js auto-install."
    fi
  fi

  have node || fail "Node.js installation failed (node not found)."
  have npm || fail "Node.js installation failed (npm not found)."
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" -ge "$SUPPORTED_NODE_MAJOR" ]] || fail "Node.js v${SUPPORTED_NODE_MAJOR}+ required, found $(node -v)"
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
  download_to_stdout https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"

  have rustc || fail "Rust install failed: rustc not found"
  have cargo || fail "Rust install failed: cargo not found"
  log "Rust ready: $(rustc --version)"
}

ensure_ollama() {
  if have ollama; then
    log "Ollama detected: $(ollama --version 2>&1 | head -n1)"
  else
    warn "Ollama not found — required for local embeddings and the default cogito:3b chat model."
    confirm "Install Ollama now via the official script (curl | sh)?" || {
      warn "Skipping Ollama install; embeddings and local chat will be degraded."
      return
    }
    download_to_stdout https://ollama.com/install.sh | sh
    have ollama || fail "Ollama install failed: ollama not found after install"
  fi

  if ! ollama list >/dev/null 2>&1; then
    log "Starting ollama daemon in background"
    (ollama serve >/dev/null 2>&1 &) || true
    sleep 3
  fi

  for model in nomic-embed-text cogito:3b; do
    if ollama list 2>/dev/null | awk '{print $1}' | grep -Fxq "$model"; then
      log "Ollama model already present: $model"
      continue
    fi
    log "Pulling Ollama model: $model (this may take a few minutes)"
    ollama pull "$model" || warn "Failed to pull $model (continuing; you can retry later)"
  done
}

check_core_tools() {
  have git || fail "missing required core tool: git"
  have_downloader || fail "missing required downloader: need curl, wget, or python3"
}

check_node22() {
  have node || fail "Node.js v${SUPPORTED_NODE_MAJOR}+ is required"
  have npm || fail "npm is required"

  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" -ge "$SUPPORTED_NODE_MAJOR" ]] || fail "Node.js v${SUPPORTED_NODE_MAJOR}+ required, found $(node -v)"
}

check_rust_stable() {
  have rustc || fail "Rust stable is required (rustc missing)"
  have cargo || fail "Rust stable is required (cargo missing)"

  local channel
  channel="$(rustc -vV | awk -F': ' '/^release:/{print $2}')"
  [[ "$channel" != *nightly* ]] || fail "Rust stable is required (nightly detected)"
}

detect_repo_mode() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local maybe_repo
  maybe_repo="$(cd "$script_dir/.." && pwd)"

  if [[ -f "$maybe_repo/package.json" ]] && grep -Eq '"@memphis-chains/memphis"' "$maybe_repo/package.json"; then
    TARGET_DIR="$maybe_repo"
    REPO_MODE="source-checkout"
    return
  fi

  REPO_MODE="git-clone"
}

emit_check_only_summary() {
  local repo_mode="$1"
  local node_version rust_version
  node_version="$(node -v)"
  rust_version="$(rustc --version)"

  if [[ "$JSON_OUTPUT" == "1" ]]; then
    node -e "
      const payload = {
        ok: true,
        mode: 'check-only',
        platform: process.argv[1],
        repoMode: process.argv[2],
        targetDir: process.argv[3],
        nodeVersion: process.argv[4],
        rustVersion: process.argv[5],
        supportedNodeMajor: Number(process.argv[6]),
        primaryOperatorPath: 'source-checkout'
      };
      console.log(JSON.stringify(payload, null, 2));
    " "$PLATFORM" "$repo_mode" "$TARGET_DIR" "$node_version" "$rust_version" "$SUPPORTED_NODE_MAJOR"
    return
  fi

  log "Check-only install contract: PASS"
  log "Platform: $PLATFORM"
  log "Primary operator path: source-checkout"
  log "Repo mode: $repo_mode"
  log "Target dir: $TARGET_DIR"
  log "Node: $node_version"
  log "Rust: $rust_version"
}

resolve_repo() {
  detect_repo_mode
  if [[ "$REPO_MODE" == "source-checkout" ]]; then
    log "Using local Memphis repository: $TARGET_DIR"
    return
  fi

  mkdir -p "$INSTALL_BASE"
  if [[ -d "$TARGET_DIR/.git" ]]; then
    log "Updating existing repo: $TARGET_DIR"
    git -C "$TARGET_DIR" fetch --all --prune

    # Detect dirty state so the upgrade never aborts on local changes.
    # Auto-stash with a labeled entry — user recovers explicitly via
    # `git stash list | grep memphis-install-autostash`. No auto-pop:
    # surprise merges inside a curl|bash installer are unacceptable.
    local dirty_tracked=0
    local dirty_untracked=0
    git -C "$TARGET_DIR" diff --quiet HEAD -- 2>/dev/null || dirty_tracked=1
    if [[ -n "$(git -C "$TARGET_DIR" ls-files --others --exclude-standard 2>/dev/null)" ]]; then
      dirty_untracked=1
    fi

    if (( dirty_tracked == 1 || dirty_untracked == 1 )); then
      local stash_label="memphis-install-autostash-$(date -u +%Y%m%dT%H%M%SZ)"
      warn "Worktree has local changes — auto-stashing as '$stash_label'."
      warn "Restore later with: git -C $TARGET_DIR stash list | grep $stash_label"
      if ! git -C "$TARGET_DIR" stash push --include-untracked --message "$stash_label" >/dev/null; then
        fail "Auto-stash failed. Clean $TARGET_DIR manually (git status) and re-run installer."
      fi
    fi

    if ! git -C "$TARGET_DIR" pull --ff-only; then
      fail "Pull failed even after auto-stash. Inspect $TARGET_DIR manually."
    fi
  else
    if [[ -d "$TARGET_DIR" ]] && [[ -n "$(ls -A "$TARGET_DIR" 2>/dev/null || true)" ]]; then
      fail "Target directory exists and is not empty: $TARGET_DIR"
    fi
    log "Cloning Memphis into $TARGET_DIR"
    git clone "$REPO_URL" "$TARGET_DIR"
  fi
}

print_next_steps() {
  local init_note="No vault, no soul state, no agent identity has been created yet.
  Installation is technical only — first-run is a deliberate step."
  local step_one="• memphis init              # passphrase, vault, identity, first-run
    • memphis auth anthropic    # (optional) browser OAuth login for Claude
    • memphis doctor            # verify everything is healthy"
  if [[ "$WITH_INIT" == "1" ]]; then
    init_note="First-run already completed via --with-init. Vault + identity are in place."
    step_one="• memphis auth anthropic    # (optional) browser OAuth login for Claude
    • memphis doctor            # verify everything is healthy"
  fi
  cat <<EOF

╔════════════════════════════════════════════════════════════════╗
║                  Memphis installed successfully                ║
╚════════════════════════════════════════════════════════════════╝

  Install location : $TARGET_DIR
  CLI              : $(command -v memphis || echo "memphis (via: cd $TARGET_DIR && npm run -s cli --)")
  Node             : $(node -v)
  Rust             : $(rustc --version | awk '{print $1, $2}')

  $init_note

  Next steps (in order):

    $step_one
    • memphis service install   # install & enable systemd user service
    • memphis service restart   # start (or restart) the runtime
    • memphis tui               # open the native operator console
    • In the TUI: /tier 3 <operator-passphrase> grants 3h of unrestricted
       mutation (overwrite existing files anywhere, freeform sudo), then
       auto-reverts. Default tier 2 is safe: creates/installs/downloads
       freely, but cannot modify existing files outside ~/memphis/.

  Everyday commands:

    memphis health               # runtime health check
    memphis service status       # is the daemon alive?
    memphis service logs -n 100  # recent logs
    memphis tui                  # interactive console
    memphis providers list       # configured LLM providers
    memphis vault list           # inspect vault entries
    memphis doctor --fix         # auto-repair degraded state

  Documentation: https://github.com/Memphis-Chains/memphis#readme
EOF
}

main() {
  parse_args "$@"
  if [[ "$CHECK_ONLY" != "1" || "$JSON_OUTPUT" != "1" ]]; then
    log "Starting Memphis installer"
  fi
  detect_os
  if [[ "$CHECK_ONLY" != "1" || "$JSON_OUTPUT" != "1" ]]; then
    log "Detected platform: $PLATFORM"
  fi

  if [[ "$CHECK_ONLY" == "1" ]]; then
    check_core_tools
    check_node22
    check_rust_stable
    detect_repo_mode
    emit_check_only_summary "$REPO_MODE"
    return
  fi

  ensure_core_tools
  ensure_build_essentials
  ensure_node22
  ensure_rust_stable
  ensure_ollama
  resolve_repo

  cd "$TARGET_DIR"
  log "Installing npm dependencies"
  npm install

  log "Building Memphis (Rust crates + TypeScript)"
  npm run build

  log "Linking global CLI (npm link)"
  if ! npm link 2>/dev/null; then
    warn "npm link failed without sudo; retrying with sudo"
    if need_sudo && have sudo; then
      sudo -E env "PATH=$PATH" npm link || warn "sudo npm link also failed — use 'cd $TARGET_DIR && npm run -s cli -- <cmd>' as fallback"
    else
      warn "Could not globally link CLI — use 'cd $TARGET_DIR && npm run -s cli -- <cmd>' as fallback"
    fi
  fi

  if [[ "$WITH_INIT" == "1" ]]; then
    if [[ ! -t 0 ]]; then
      warn "--with-init requires a TTY for passphrase prompts; skipping and falling back to next-steps banner."
    else
      log "Running 'memphis init' (interactive)"
      if have memphis; then
        memphis init || warn "memphis init returned non-zero; rerun manually once ready."
      else
        (cd "$TARGET_DIR" && npm run -s cli -- init) \
          || warn "memphis init returned non-zero; rerun manually once ready."
      fi
    fi
  fi

  print_next_steps
}

main "$@"
