# Pre-reset validation checklist (2026-05-13)

Operator-facing list of surfaces to verify **before** triggering the
post-Y1 reset milestone. Each item maps to one or more PRs from the
2026-05-12 → 2026-05-13 REV2/REV5 sprint queue.

## Goal

Confirm every surface that landed in Y1 actually works on operator's
daemon. Catch silent regressions before the fresh `memphis init`
wipes state — once reset runs, debugging which Y1 fix went stale on
the old chain becomes a history problem rather than a fix-it problem.

---

## 1. T0 / #595 — audit-write VITEST guard

**Goal:** new test runs can't poison the live `~/.memphis/chains/system/`.

```bash
# From a clean repo clone:
npx vitest run tests/unit/audit-write-guard.test.ts --reporter=dot
# Expected: 12 cases green. No new blocks under ~/.memphis/chains/system/.
```

If a future test escapes (writes `system_event` with `sessionId: "sess-N"`
fixtures to the live chain), the next operator-side chain integrity scan
will flag the new block. Use the bootstrap's `chain.verify.startup`
audit entry to track this.

## 2. T1 / #596 — Telegram vision + exec tier-3 plumbing

**Goal:** photos persist; `/tier 3` actually elevates exec.

1. Operator sends a photo to the Telegram bot.
2. **Verify**: `ls -la ~/.memphis/state/telegram-attachments/`
   shows a `tg-photo-*.jpg|.png|.webp` file with mtime within the last
   minute. File should NOT be unlinked.
3. Operator: `/tier 3 <pass>` in Telegram.
4. Operator: "Memphis, uruchom `file ~/.memphis/state/telegram-attachments/tg-photo-*.jpg`".
5. **Verify**: agent's reply contains the file output (e.g., "JPEG
   image data, baseline, 1080x1920"). No "shell metacharacters blocked"
   error.
6. **Verify audit**: `tail -n 50 ~/.memphis/audit-log.jsonl | grep exec.attempt`
   shows the `exec.attempt` event with the operator's prompt as
   `surface_intent`.

## 3. T2 / #597 — embed_shutdown race fix

**Goal:** restart doesn't SEGV any more.

```bash
# In a loop, restart 5x in a row. Pre-fix: ~5/8 attempts SEGV.
# Post-fix: clean exit every time.
for i in 1 2 3 4 5; do
  systemctl --user restart memphis
  sleep 2
  systemctl --user is-active memphis || echo "FAILED on iter $i"
  coredumpctl list --since "10 seconds ago" 2>&1 | tail -2
done
```

Also confirm `embed-shutdown-state.ts` flag is set after each shutdown:
audit entries `shutdown.embed-shutdown` should appear with
`caller: graceful-shutdown:step-5.5` (not `napi-shutdown:beforeExit`)
once per service lifetime.

## 4. T3.5 / #601 — exec wisdom doctrine + Codex round-1 #605 patch

**Goal:** agent ANALYZES before destructive exec.

1. `/tier 3 <pass>`.
2. "Memphis, usuń `/tmp/karto-smoke-test/`".
3. **Verify**: agent first calls `memphis_exec_analyze("rm -rf /tmp/karto-smoke-test/")`.
4. **Verify**: agent surfaces analysis to operator BEFORE running:
   "to skasuje katalog X (irreversible, ask-operator). Ok?"
5. Operator: "tak".
6. **Verify audit**: 3 events emitted —
   `memphis_exec_analyze.<no-action-yet>`, `exec.attempt` with the
   analysis context attached, `exec.result` with the actual exit code.
7. **Verify soul-seed**: `cat ~/.memphis/soul-memory.json` (or query
   `memphis recall "exec wisdom"`) — should surface the 6-rule doctrine
   from `soul-seed:exec-wisdom`. Only present after a fresh init
   following #605 merge; pre-existing installs need a re-seed for the
   entry to appear in chain.

## 5. T4 / #602 — transformers preflight

**Goal:** smoke training surfaces F8 (transformers<4.48) with copy-pasteable
remediation.

```bash
# In a venv WITHOUT transformers >=4.48 installed (or remove it):
pip uninstall -y transformers && pip install transformers==4.46
python3 tools/training/train-kartograf.py --mode smoke \
  --corpus ~/.memphis/kartograf/corpus/v1 \
  --out /tmp/karto-smoke-test \
  --signing-seed-file <(openssl rand 32)
# Expected: exit 1, stderr contains:
#   [train-kartograf] installed transformers 4.46.0 lacks ModernBERT
#   support (requires >=4.48). ... Run: pip install --upgrade
#   'transformers>=4.48,<4.50'
```

After upgrading transformers + re-running, smoke should actually
train (50 steps, real ONNX bytes on completion).

## 6. T5 / #605 — Codex round-1 bundled hotfix

Each item lands on top of T1-T4 surfaces. Verify:

- **W1** Telegram retention cron: `bash crons/prune-telegram-attachments.sh`
  with a few > 7d files → expected JSON output showing prune count +
  unlinked filenames.
- **W2** `glob.ts` install-root: `memphis_glob` works in a non-`~/memphis`
  install (e.g., `MEMPHIS_INSTALL_ROOT=/opt/memphis`). Pre-fix: glob
  refused every path. Post-fix: searches relative to install root.
- **N1** glob symlink hardening: create a symlink
  `~/.memphis/state/telegram-attachments/evil -> /etc/`. `memphis_glob`
  invocation referencing that path should refuse (the realpath resolves
  outside the allowlist).
- **W1** soul-seed: fresh `memphis init` after #605 merge → journal
  chain contains a `soul-seed:exec-wisdom` block.
- **N1** runMemphisExec WARN: production call without surface/actorId
  threading writes a `[memphis-exec] WARN: budget-key threading missing`
  line to stderr / journalctl.

## 7. Block 1853 fork-marker tolerance / #603

**Goal:** daemon restarts cleanly after the 2026-05-12 corruption.

```bash
systemctl --user restart memphis
sleep 4
systemctl --user status memphis --no-pager | head -15
# Expected: Active: active (running). Audit log entry:
#   action: chain.verify.startup
#   status: mitigated
#   mitigation: known-fork-marker accepted per operator decision
```

Pre-fix: `Failed with result 'exit-code'`. Post-fix: clean start +
audit trail showing the fork-marker mitigation.

## 8. Daemon process health (smoke)

```bash
memphis doctor --json | jq '.summary'
# Expected: { "ok": true, "ta_failures": [], ... }
# Pre-reset: all ta01-ta13 plus the new ta14-ta18 (if T7 ships) should
# be `ok: true`.
```

```bash
curl -sf http://127.0.0.1:8080/v1/ops/status | jq '.startup'
# Expected: queueResume.policy in {"keep", "redispatch"}, no errors.
```

---

## What this checklist intentionally does NOT cover

- **T6** (TUI SEGV) — only check if operator observes a TUI SEGV after
  the T2 fix. If clean, T6 closed without action.
- **T7** (bedtime auto-training, BIG FINAL) — 3-5 day separate sprint.
  Verified independently via the Telegram "dobranoc, weź trening" flow
  + `/nightly status` + morning ping.
- **Operator-driven reset** — the reset itself is operator-only per
  handoff section 8. This list is the gate BEFORE the reset, not the
  reset procedure itself.

## Sign-off

When every item above is green AND operator confirms TUI + Telegram
both responsive, the Y1 sprint queue is closed. Operator can then
schedule the reset milestone at their convenience.
