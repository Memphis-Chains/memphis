#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/release.sh [patch|minor|major|--version <semver>] [--dry-run]

Options:
  --version   Use an explicit semver version instead of a patch/minor/major bump.
  --dry-run   Show actions without writing files, creating commits or tags.

This script is for final GA or hotfix tag releases. Use
`./scripts/prepare-release-candidate.sh --version <semver-prerelease>` for RC cuts.
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
    printf -- "- Maintenance release.\n"
  elif [[ "${#commits[@]}" -gt "$printed" ]]; then
    printf -- "- ... plus %d additional commits.\n" "$(( ${#commits[@]} - printed ))"
  fi
}

BUMP=""
EXPLICIT_VERSION=""
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    patch|minor|major)
      if [[ -n "$BUMP" ]]; then
        echo "Error: bump type specified more than once." >&2
        usage
        exit 1
      fi
      BUMP="$1"
      ;;
    --version)
      if [[ $# -lt 2 ]]; then
        echo "Error: --version requires a semver value." >&2
        usage
        exit 1
      fi
      if [[ -n "$EXPLICIT_VERSION" ]]; then
        echo "Error: --version specified more than once." >&2
        usage
        exit 1
      fi
      EXPLICIT_VERSION="$2"
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

if [[ -n "$BUMP" && -n "$EXPLICIT_VERSION" ]]; then
  echo "Error: use either a bump type or --version, not both." >&2
  usage
  exit 1
fi

if [[ -z "$BUMP" && -z "$EXPLICIT_VERSION" ]]; then
  echo "Error: version bump type or --version is required." >&2
  usage
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
if [[ -n "$EXPLICIT_VERSION" ]]; then
  if [[ ! "$EXPLICIT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
    echo "Error: --version must be semver-like (example: 1.0.0)." >&2
    exit 1
  fi
  NEW_VERSION="$EXPLICIT_VERSION"
else
  NEW_VERSION=$(node -e "
const fs = require('fs');
const bump = process.argv[1];
const current = process.argv[2];
const [major, minor, patch] = current.split('.').map((v) => parseInt(v, 10));
if ([major, minor, patch].some(Number.isNaN)) {
  throw new Error('Current version is not semver-compatible: ' + current);
}
let next = [major, minor, patch];
if (bump === 'major') next = [major + 1, 0, 0];
if (bump === 'minor') next = [major, minor + 1, 0];
if (bump === 'patch') next = [major, minor, patch + 1];
process.stdout.write(next.join('.'));
" "$BUMP" "$CURRENT_VERSION")
fi

TAG="v${NEW_VERSION}"
DATE=$(date +%F)

if [[ "$DRY_RUN" != "true" ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Error: tracked working tree is not clean. Commit or stash tracked changes first." >&2
    exit 1
  fi
  if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
    echo "Warning: untracked files present; ignoring them for release automation." >&2
  fi
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Error: releases must be cut from 'main' (current: ${CURRENT_BRANCH})." >&2
  exit 1
fi

if git show-ref --verify --quiet refs/remotes/origin/main; then
  LOCAL_SHA=$(git rev-parse HEAD)
  REMOTE_SHA=$(git rev-parse refs/remotes/origin/main)
  BASE_SHA=$(git merge-base HEAD refs/remotes/origin/main)
  if [[ "$LOCAL_SHA" != "$REMOTE_SHA" && "$LOCAL_SHA" == "$BASE_SHA" ]]; then
    echo "Error: local main is behind origin/main. Pull or rebase before release." >&2
    exit 1
  fi
  if [[ "$LOCAL_SHA" != "$REMOTE_SHA" && "$REMOTE_SHA" != "$BASE_SHA" ]]; then
    echo "Error: local main has diverged from origin/main. Resolve before release." >&2
    exit 1
  fi
fi

LAST_TAG=""
if LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null); then
  CHANGELOG_RANGE="${LAST_TAG}..HEAD"
else
  CHANGELOG_RANGE=""
fi
CHANGELOG_SUMMARY=$(build_changelog_summary "$CHANGELOG_RANGE")

echo "Current version: ${CURRENT_VERSION}"
echo "Next version:    ${NEW_VERSION}"
if [[ -n "$LAST_TAG" ]]; then
  echo "Changelog range: ${CHANGELOG_RANGE}"
else
  echo "Changelog range: repository history (no prior tag found)"
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] bump package.json version to ${NEW_VERSION}"
else
  node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '${NEW_VERSION}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n');
"
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] update CHANGELOG.md with ${TAG}"
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

run_cmd npm test
run_cmd npm run build
run_cmd git add package.json CHANGELOG.md
run_cmd git commit -m "chore(release): ${TAG}"
run_cmd git tag "${TAG}"
run_cmd git push
run_cmd git push origin "${TAG}"

echo "Release prepared: ${TAG}"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry-run complete. No files or git refs were changed."
else
  echo "Tag pushed. GitHub Actions release workflow should start automatically."
fi
