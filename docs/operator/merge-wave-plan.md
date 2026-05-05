# Merge Wave Plan — integration/pre-demo-2026-05-06 → main

Generated 2026-05-06 from Sprint δ-prep. **Operator-driven** — run the
commands yourself when you're ready. Autopilot does not push to main.

## Branch state

`integration/pre-demo-2026-05-06` is at `262e45c` (Sprint ν shipped).
33 commits ahead of `origin/main`. Tests green, smoke `READY (with 2
warnings)`.

## Current open-PR census (21 total)

### Bucket A — already on integration (15 PRs, close as superseded)

These were cherry-picked into integration in the pre-demo sprint. Once
the integration branch lands on main, they're redundant. Close with
comment: "superseded by integration/pre-demo-2026-05-06 merge".

```
#497 feat(media): B3 audio + image pipeline
#495 fix(gateway): surface finish_reason='length' truncation warning
#494 fix(cognitive): respect GEN_MAX_TOKENS env override
#493 fix(prompt): forbid bot apologies
#491 fix(minimax): accept symmetric <minimax:tool_call> wrapper
#490 fix(voice): probe /health then /inference
#488 feat(cli): memphis openai configure
#487 feat(cli): memphis brave configure
#486 feat(tools): memphis_brave_search
#484 feat(anti-confab): phase 2 enforce
#483 fix(loop): max_steps 32 → 48
#482 feat(anti-confab): runtime audit
#481 docs(ops): pre-demo checklist
#479 fix(build): curve25519-dalek backend=serial
#478 feat(anti-confab): search-claim guard
```

### Bucket B — independent + green (1 PR, squash-merge to main)

```
#480 test(integration): chain_hits behavioral compliance
```

CI clean, mergeable. Just merge.

### Bucket C — CI-blocked (5 PRs, UNSTABLE — rebase + retest)

```
#498 fix(tokens): bigger output budgets — 2048 → 8192/16384
#496 docs(media): B1 + B2 module specifications
#492 feat(doctor): render Recent operator actions section
#489 feat(self-describe): surface recent config-changes
#485 test(integration): pin anti-confab end-to-end pipeline
```

Each has 1 failing check. Most likely cause: stacked on pre-`7d13bcb`
test fix; rebase onto current main will clear. If a real test
regression surfaces post-rebase, that PR needs a fix commit before
merge.

## Recommended sequence

### Step 1 — land integration to main

Cleanest path: open ONE PR for the full integration branch.

```bash
# Verify branch is current
git checkout integration/pre-demo-2026-05-06
git pull --ff-only

# Create merge-PR
gh pr create \
  --base main \
  --head integration/pre-demo-2026-05-06 \
  --title "integration: pre-demo-2026-05-06 → main (33 commits)" \
  --body "$(cat <<'EOF'
Squash-merge wave for everything shipped in the pre-demo sprint and
post-demo autopilot:

**Pre-demo (Sprint A-D):**
- AVX2 SIGILL fix (curve25519-dalek backend=serial)
- Anti-confab phases 1-4 stack
- B3 vision pipeline (memphis_media_ingest)
- Brave Search API tool + configure CLI
- OpenAI configure CLI
- MiniMax XML parser symmetric form
- GEN_MAX_TOKENS plumbing + finishReason warning
- No-apologies prompt
- Pre-demo smoke + checklist

**Post-demo autopilot (Sprint α-ν):**
- α anti-confab Phase 3 (Rule D + tool-result anchoring)
- β chain catalog cleanup (TS uses valid Rust BlockType + kind)
- γ embedding rebuild Ollama 500 fix (sanitise + skip-and-log)
- ε voice STT operator-actionable errors
- ζ Tesseract OCR (pol+eng) for screenshots
- η.1 DID identity init (clears t4-did doctor warn)
- θ cargo update — patch-level transitive deps
- ν tier-3 expiry active notifications

Closes #478 #479 #481 #482 #483 #484 #486 #487 #488 #490 #491 #493
#494 #495 #497.
EOF
)"
```

Wait for CI to pass on the merge-PR. If green:

```bash
gh pr merge --squash <PR-number>
```

### Step 2 — close superseded PRs (Bucket A)

```bash
for pr in 478 479 481 482 483 484 486 487 488 490 491 493 494 495 497; do
  gh pr close $pr --comment "Superseded by integration/pre-demo-2026-05-06 merge."
done
```

### Step 3 — squash-merge bucket B

```bash
gh pr merge 480 --squash
```

### Step 4 — rebase bucket C

For each: rebase onto fresh main, push, retest CI.

```bash
for pr in 485 489 492 496 498; do
  echo "=== Rebase #$pr ==="
  branch=$(gh pr view $pr --json headRefName -q .headRefName)
  git checkout $branch
  git fetch origin main
  git rebase origin/main || { echo "MANUAL: resolve conflicts on $branch"; break; }
  git push --force-with-lease origin $branch
  gh pr ready $pr
done
```

If CI passes after rebase, merge:

```bash
for pr in 485 489 492 496 498; do
  gh pr merge $pr --squash
done
```

If a rebase produces conflicts or a real test regression, the PR
needs operator attention — drop it from the loop and handle
manually.

## Post-merge cleanup

- `git branch -d integration/pre-demo-2026-05-06` (and `git push origin --delete`)
- Update `MEMORY.md` `_evening_pre_demo` entry with new main tip
- Tag v1.9.0 if you want to mark the milestone (`git tag v1.9.0 && git push --tags`)

## Stop conditions

- CI red on the integration → main merge-PR after rebase: stop, fix
  before continuing
- A bucket-C rebase produces conflicts: skip, handle manually
- Discovery that a "superseded" PR (Bucket A) actually has commits
  NOT yet on integration: re-categorise to Bucket B/C
