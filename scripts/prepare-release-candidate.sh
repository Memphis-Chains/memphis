#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/prepare-release-candidate.sh --version <semver-prerelease> [--dry-run]

Options:
  --version   Required semver prerelease (example: 1.0.0-rc.1)
  --dry-run   Show actions without writing files or creating commits.
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: $1 is required." >&2
    exit 1
  fi
}

run_cmd() {
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

build_changelog_summary() {
  local range="$1"
  local -a commits=()
  local subject
  local printed=0

  if [[ -n "$range" ]]; then
    mapfile -t commits < <(git log --no-merges --pretty=format:%s "$range")
  else
    mapfile -t commits < <(git log --no-merges --pretty=format:%s -n 12)
  fi

  for subject in "${commits[@]}"; do
    [[ -z "$subject" ]] && continue
    printf -- "- %s\n" "$subject"
    printed=$((printed + 1))
    [[ "$printed" -ge 12 ]] && break
  done

  if [[ "$printed" -eq 0 ]]; then
    printf -- "- Release candidate build.\n"
  elif [[ "${#commits[@]}" -gt "$printed" ]]; then
    printf -- "- ... plus %d additional commits.\n" "$(( ${#commits[@]} - printed ))"
  fi
}

ensure_tracked_tree_is_clean() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Error: tracked working tree is not clean. Commit or stash tracked changes first." >&2
    exit 1
  fi

  local untracked
  untracked="$(git ls-files --others --exclude-standard)"
  if [[ -n "$untracked" ]]; then
    echo "Warning: untracked files present; ignoring them for RC prep." >&2
    printf '%s\n' "$untracked" >&2
  fi
}

VERSION=""
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      if [[ $# -lt 2 ]]; then
        echo "Error: --version requires a value." >&2
        usage
        exit 1
      fi
      VERSION="$2"
      shift
      ;;
    --dry-run)
      DRY_RUN="true"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

if [[ -z "$VERSION" ]]; then
  echo "Error: --version is required." >&2
  usage
  exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+$ ]]; then
  echo "Error: release candidate version must be a semver prerelease like 1.0.0-rc.1." >&2
  exit 1
fi

require_cmd node
require_cmd git
require_cmd npm

if [[ ! -f CHANGELOG.md ]]; then
  echo "Error: CHANGELOG.md not found." >&2
  exit 1
fi

CURRENT_VERSION=$(node -p "require('./package.json').version")
if [[ "$CURRENT_VERSION" == "$VERSION" ]]; then
  echo "Error: package.json is already at version $VERSION." >&2
  exit 1
fi

if [[ "$DRY_RUN" != "true" ]]; then
  ensure_tracked_tree_is_clean
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Error: RCs must be prepared from 'main' (current: ${CURRENT_BRANCH})." >&2
  exit 1
fi

if git show-ref --verify --quiet refs/remotes/origin/main; then
  LOCAL_SHA=$(git rev-parse HEAD)
  REMOTE_SHA=$(git rev-parse refs/remotes/origin/main)
  BASE_SHA=$(git merge-base HEAD refs/remotes/origin/main)
  if [[ "$LOCAL_SHA" != "$REMOTE_SHA" && "$LOCAL_SHA" == "$BASE_SHA" ]]; then
    echo "Error: local main is behind origin/main. Pull or rebase before preparing an RC." >&2
    exit 1
  fi
  if [[ "$LOCAL_SHA" != "$REMOTE_SHA" && "$REMOTE_SHA" != "$BASE_SHA" ]]; then
    echo "Error: local main has diverged from origin/main. Resolve before preparing an RC." >&2
    exit 1
  fi
fi

LAST_TAG=""
if LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null); then
  CHANGELOG_RANGE="${LAST_TAG}..HEAD"
else
  CHANGELOG_RANGE=""
fi
CHANGELOG_SUMMARY="$(build_changelog_summary "$CHANGELOG_RANGE")"
TAG="v${VERSION}"
DATE="$(date +%F)"

echo "Current version: ${CURRENT_VERSION}"
echo "RC version:      ${VERSION}"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] synchronize package, lockfile, and README versions to ${VERSION}"
else
  node ./scripts/set-release-version.mjs "${VERSION}"
fi

if grep -q "^## ${TAG} - " CHANGELOG.md; then
  echo "Changelog already contains ${TAG}; leaving existing section in place."
elif [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] prepend CHANGELOG.md with ${TAG}"
  echo "## ${TAG} - ${DATE}"
  echo
  printf '%s\n' "$CHANGELOG_SUMMARY"
else
  TMP_FILE=$(mktemp)
  {
    echo "## ${TAG} - ${DATE}"
    echo
    printf '%s\n' "$CHANGELOG_SUMMARY"
    echo
    cat CHANGELOG.md
  } > "$TMP_FILE"
  mv "$TMP_FILE" CHANGELOG.md
fi

run_cmd bash ./scripts/run-release-gates.sh
run_cmd git add package.json npm-shrinkwrap.json README.md README.pl.md CHANGELOG.md
run_cmd git commit -m "chore(release): ${TAG}"

echo
echo "Next step:"
printf 'gh workflow run release-draft-dispatch.yml --repo Memphis-Chains/memphis -f version=%q -f target_ref=main -f confirm=draft-release\n' "$VERSION"
