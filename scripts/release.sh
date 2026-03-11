#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/release.sh [patch|minor|major] [--dry-run]

Options:
  --dry-run   Show actions without writing files, creating commits or tags.
EOF
}

BUMP=""
DRY_RUN="false"

for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP="$arg" ;;
    --dry-run) DRY_RUN="true" ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$BUMP" ]]; then
  echo "Error: version bump type is required (patch|minor|major)." >&2
  usage
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required." >&2
  exit 1
fi

CURRENT_VERSION=$(node -p "require('./package.json').version")
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

TAG="v${NEW_VERSION}"
DATE=$(date +%F)

run_cmd() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] $*"
  else
    eval "$@"
  fi
}

if [[ "$DRY_RUN" != "true" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Error: working tree is not clean. Commit or stash changes first." >&2
    exit 1
  fi
fi

echo "Current version: ${CURRENT_VERSION}"
echo "Next version:    ${NEW_VERSION}"

run_cmd "node -e '
const fs = require(\"fs\");
const pkg = JSON.parse(fs.readFileSync(\"package.json\", \"utf8\"));
pkg.version = \"${NEW_VERSION}\";
fs.writeFileSync(\"package.json\", JSON.stringify(pkg, null, 2) + \"\\n\");
'"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] update CHANGELOG.md with ${TAG}"
else
  TMP_FILE=$(mktemp)
  {
    echo "## ${TAG} - ${DATE}"
    echo
    echo "- TODO: summarize release changes"
    echo
    cat CHANGELOG.md
  } > "$TMP_FILE"
  mv "$TMP_FILE" CHANGELOG.md
fi

run_cmd "npm test"
run_cmd "npm run build"
run_cmd "git add package.json CHANGELOG.md"
run_cmd "git commit -m 'chore(release): ${TAG}'"
run_cmd "git tag ${TAG}"
run_cmd "git push"
run_cmd "git push origin ${TAG}"

echo "Release prepared: ${TAG}"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry-run complete. No files or git refs were changed."
else
  echo "Tag pushed. GitHub Actions release workflow should start automatically."
fi
