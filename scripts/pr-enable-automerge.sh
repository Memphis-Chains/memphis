#!/usr/bin/env bash
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI not found"
  exit 1
fi

HEAD_BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"

if [[ "$HEAD_BRANCH" == "main" ]]; then
  echo "ERROR: run from feature branch or pass branch name explicitly"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh is not authenticated"
  exit 1
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

# Ensure label exists
if ! gh label list --limit 200 | awk '{print $1}' | grep -qx automerge; then
  gh label create automerge --color 0e8a16 --description "Enable workflow auto-merge"
fi

# Find or create PR
PR_URL=$(gh pr list --head "$HEAD_BRANCH" --json url --jq '.[0].url' || true)
if [[ -z "$PR_URL" ]]; then
  PR_URL=$(gh pr create --base main --head "$HEAD_BRANCH" --fill-first)
fi

# Label + enable auto merge
gh pr edit "$PR_URL" --add-label automerge
gh pr merge "$PR_URL" --auto --squash

echo "AUTO_MERGE_ARMED: $PR_URL"