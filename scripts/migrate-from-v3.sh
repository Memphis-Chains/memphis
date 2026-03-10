#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

V3_HOME="${MEMPHIS_V3_HOME:-$HOME/.memphis}"
CHAINS_DIR=""
EXPORT_DIR="$ROOT_DIR/data/migration-v3/export"
OUT_DIR="$ROOT_DIR/data/migration-v3/converted"
REPORT_DIR="$ROOT_DIR/data/migration-v3/reports"
SKIP_CONVERT="false"

log() { printf '[migrate-v3] %s\n' "$*"; }
warn() { printf '[migrate-v3][warn] %s\n' "$*" >&2; }
die() { printf '[migrate-v3][error] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: scripts/migrate-from-v3.sh [options]

Optional helper to export legacy v3 chain files and convert them to v4 canonical format.

Options:
  --v3-home <path>      Legacy v3 home directory (default: ~/.memphis)
  --chains-dir <path>   Explicit v3 chains directory (overrides auto-detect)
  --export-dir <path>   Export destination for raw v3 files
  --out-dir <path>      Converted v4 output directory
  --report-dir <path>   JSON conversion reports directory
  --skip-convert        Only export v3 files, do not run v4 conversion
  -h, --help            Show this help

Environment:
  MEMPHIS_V3_HOME       Alternative default for --v3-home

Examples:
  scripts/migrate-from-v3.sh
  scripts/migrate-from-v3.sh --v3-home ~/.config/memphis --out-dir ./data/migration-v3/v4
  scripts/migrate-from-v3.sh --chains-dir /backup/memphis/chains --skip-convert
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --v3-home)
      [[ $# -ge 2 ]] || die "Missing value for --v3-home"
      V3_HOME="$2"
      shift 2
      ;;
    --chains-dir)
      [[ $# -ge 2 ]] || die "Missing value for --chains-dir"
      CHAINS_DIR="$2"
      shift 2
      ;;
    --export-dir)
      [[ $# -ge 2 ]] || die "Missing value for --export-dir"
      EXPORT_DIR="$2"
      shift 2
      ;;
    --out-dir)
      [[ $# -ge 2 ]] || die "Missing value for --out-dir"
      OUT_DIR="$2"
      shift 2
      ;;
    --report-dir)
      [[ $# -ge 2 ]] || die "Missing value for --report-dir"
      REPORT_DIR="$2"
      shift 2
      ;;
    --skip-convert)
      SKIP_CONVERT="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

command -v memphis >/dev/null 2>&1 && log "Detected legacy v3 CLI: $(memphis --version 2>/dev/null || echo 'memphis (version unknown)')" || warn "Legacy v3 CLI (memphis) not found in PATH. Continuing with filesystem-only migration."

if [[ -z "$CHAINS_DIR" ]]; then
  candidates=(
    "$V3_HOME/chains"
    "$HOME/.config/memphis/chains"
    "$HOME/.local/share/memphis/chains"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -d "$candidate" ]]; then
      CHAINS_DIR="$candidate"
      break
    fi
  done
fi

[[ -n "$CHAINS_DIR" ]] || die "Could not locate legacy chains directory. Use --chains-dir <path>."
[[ -d "$CHAINS_DIR" ]] || die "Legacy chains directory does not exist: $CHAINS_DIR"

mkdir -p "$EXPORT_DIR" "$OUT_DIR" "$REPORT_DIR"

mapfile -t chain_files < <(find "$CHAINS_DIR" -maxdepth 3 -type f -name '*.json' | sort)
[[ ${#chain_files[@]} -gt 0 ]] || die "No JSON chain files found in: $CHAINS_DIR"

log "Exporting ${#chain_files[@]} file(s) from: $CHAINS_DIR"
for src in "${chain_files[@]}"; do
  rel="${src#"$CHAINS_DIR"/}"
  safe_rel="${rel//\//__}"
  cp "$src" "$EXPORT_DIR/$safe_rel"
  log "exported: $rel"
done

if [[ "$SKIP_CONVERT" == "true" ]]; then
  log "Skipping conversion (--skip-convert enabled)."
  log "Done. Exported files are in: $EXPORT_DIR"
  exit 0
fi

if command -v memphis-v4 >/dev/null 2>&1; then
  V4_CMD=("memphis-v4")
elif [[ -x "$ROOT_DIR/bin/memphis-v4.js" ]]; then
  V4_CMD=("node" "$ROOT_DIR/bin/memphis-v4.js")
else
  V4_CMD=("npm" "run" "-s" "cli" "--")
fi

ok=0
fail=0

log "Converting exported files to v4 canonical format"
for exported in "$EXPORT_DIR"/*.json; do
  base="$(basename "$exported")"
  out="$OUT_DIR/${base%.json}.v4.json"
  report="$REPORT_DIR/${base%.json}.report.json"

  if "${V4_CMD[@]}" chain import_json --file "$exported" --write --confirm-write --out "$out" --json >"$report"; then
    log "converted: $base -> $(basename "$out")"
    ok=$((ok + 1))
  else
    warn "conversion failed: $base (see $report)"
    fail=$((fail + 1))
  fi
done

log "Summary: converted=$ok failed=$fail"
log "Export dir : $EXPORT_DIR"
log "Output dir : $OUT_DIR"
log "Reports dir: $REPORT_DIR"

if [[ $fail -gt 0 ]]; then
  die "Migration completed with failures. Inspect report JSON files."
fi

log "Migration helper finished successfully."
