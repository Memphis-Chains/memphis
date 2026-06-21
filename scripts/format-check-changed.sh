#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MODE="check"

usage() {
  cat <<'USAGE'
Usage: ./scripts/format-check-changed.sh [--write]

Checks files changed in HEAD^..HEAD with Prettier. Override the range with:
  MEMPHIS_FORMAT_BASE_REF
  MEMPHIS_FORMAT_HEAD_REF
USAGE
}

while (($# > 0)); do
  case "$1" in
    --write)
      MODE="write"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
  shift
done

BASE_REF="${MEMPHIS_FORMAT_BASE_REF:-HEAD^}"
HEAD_REF="${MEMPHIS_FORMAT_HEAD_REF:-HEAD}"
PRETTIER_BIN="${MEMPHIS_PRETTIER_BIN:-prettier}"

if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  echo "[FAIL] Format gate base ref is not available: ${BASE_REF}" >&2
  exit 2
fi

if ! git rev-parse --verify --quiet "$HEAD_REF" >/dev/null; then
  echo "[FAIL] Format gate head ref is not available: ${HEAD_REF}" >&2
  exit 2
fi

changed_files=()
while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  [[ -f "$path" ]] || continue

  if git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    changed_files+=("$path")
  fi
done < <(git diff --name-only --diff-filter=ACMR "$BASE_REF" "$HEAD_REF" --)

if [[ "${#changed_files[@]}" -eq 0 ]]; then
  echo "[PASS] No changed tracked files to format-check (${BASE_REF}..${HEAD_REF})"
  exit 0
fi

echo "Prettier ${MODE} for ${#changed_files[@]} changed tracked file(s) (${BASE_REF}..${HEAD_REF})"

if [[ "$MODE" == "write" ]]; then
  "$PRETTIER_BIN" --write --ignore-unknown "${changed_files[@]}"
else
  "$PRETTIER_BIN" --check --ignore-unknown "${changed_files[@]}"
fi
