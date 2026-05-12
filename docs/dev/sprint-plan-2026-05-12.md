# Sprint plan — 2026-05-12 evening onward

**Process.** Operator-set A/B/C sprint cadence (2026-05-12):

- **A — coding + deployment to operator runtime.** The agent (me)
  ships concrete code or analysis in a focused branch AND drives
  it all the way into operator's live daemon:

    1. Open PR with the change.
    2. Wait for CI green.
    3. Merge into `main`.
    4. `git pull` on operator's host.
    5. `npm run build` (or whatever sub-build is touched).
    6. `systemctl --user restart memphis` (or relevant surface).
    7. Verify deploy: `tools=N` matches expected, the new log
       line appears, smoke check works.

  **A-step is NOT done until the change is observable in
  operator's runtime.** Code on `main` that the daemon hasn't
  picked up doesn't count — operator can't review what they can't
  see. Operator 2026-05-12 evening: "zmiany musza byc dostepne w
  moim runtime". Captured.

  Docs-only changes are exempt (they don't need a daemon restart),
  but the agent still confirms "doc merged to main, render visible
  on github" before declaring A done.

- **B — operator review on live Memphis + logs.** Operator runs
  the now-deployed artifact against their actual daemon / TUI /
  Telegram surface, reads journalctl / coredumpctl / cron logs as
  needed, and reports back what's working, what isn't, what's
  surprising. This is the oracle — no amount of agent reasoning
  replaces it.

- **C — iterate from B.** I close the loop based on operator's
  observations: tighten the fix, kill the wrong assumption, ship
  the follow-up PR. C-step itself goes through the same A1-A7
  deployment discipline (it's a sprint within a sprint).

**Anti-isolation rule (parallel work).** Before opening any branch
that touches a non-trivial subsystem (kartograf, vault, NAPI,
shutdown path, TUI, anything tagged P0/P1 in a roadmap doc), the
agent MUST:

1. `git fetch --all --prune`
2. `gh pr list --state open --search "<subsystem>"`
3. `gh pr view <recent>` for the last 1-2 weeks
4. If another branch is in-flight for the same area: coordinate via
   PR comment FIRST, do not open a parallel branch.

Captured here so the next agent / operator can see the cadence
without re-deriving it from scratch.

---

## Sprint S1 — Confab + self_describe surface (low-risk research → operator decision)

**Goal.** Operator's full-scan flagged 23 confabulation events in
the last 7 days + `memphis_self_describe blocked` by security
policy. Both are observable-only items — no behavioural change
without operator's call on direction.

### A (mine)

- Pull the last 23 `prompt.output.confab_*` audit events. Bucket by
  rule (A/B/C/D/E), surface (Telegram / TUI / chat), evidence
  string. Write to `notes/confab-analysis-2026-05-12.md`.
- Pull the policy trace for `memphis_self_describe`. Identify why
  it's `blocked` — tier mismatch, surface policy, missing config
  flag, or audit-time gate failure.
- Open one PR with the analysis doc + (if `self_describe` block is
  a clean config fix) the one-line policy update.

### B (operator)

- Read the confab analysis. Decide: keep Phase 2 (warn-append) as
  default, or roll forward to Phase 3 (strip-sentence) as default
  on next release.
- Confirm whether `memphis_self_describe` block was intentional
  (e.g. operator-locked-down) or a regression.

### C (mine)

- If operator says "Phase 3 default": flip the default in
  `src/gateway/turn-runtime.ts:DEFAULT_CONFAB_PHASE`, update tests,
  ship.
- If operator says "system prompt needs another patch for confab
  rule X": iterate the system-prompt copy with the specific
  rule-X example.

### Done when

- Confab analysis doc merged.
- `memphis_self_describe` either fixed or documented as
  intentionally locked.
- Operator's policy call captured in CHANGELOG `Unreleased`.

---

## Sprint S2 — p99 latency triage (operator-visible perf)

**Goal.** SLO breach: p99 = 263 s, threshold 3 s. One specific
provider call must be hanging or a fallback timeout is too high.

### A (mine)

- Walk OTel spans for the last 24 h, surface the slowest 10 turns
  with timing per-provider + per-tool. Group by which call swung
  past 60 s.
- Cross-reference cascade order — was a primary timing out before
  the fallback kicked in?
- Write `notes/p99-latency-2026-05-12.md` naming the slowest path
  + a proposed per-provider timeout adjustment.

### B (operator)

- Read the analysis. Decide:
  - "lower `MEMPHIS_ANTHROPIC_TIMEOUT_MS` to N", OR
  - "pin `MINIMAX_API_KEY` and demote ollama", OR
  - "this is fine, raise the SLO threshold".

### C (mine)

- Apply the chosen env / config change as a single PR. Update
  `docs/historical/slo-baseline.md` if the threshold moved.

### Done when

- p99 latency dashboard shows < 3 s for 24 h after change.

---

## Sprint S3 — TUI SEGV on exit (defensive Drop pass)

**Goal.** Operator hit `memphis tui` → exit → "Segmentation fault
(core dumped)". Rust-side; needs interactive repro to validate.

### A (mine)

- Audit `crates/memphis-tui/src/main.rs` + `client.rs` for Drop
  order. Specifically: `TerminalGuard` (raw-mode restore) MUST
  drop BEFORE `MemphisClient` / `ExtensionHostSession` (which kill
  child processes and may emit ANSI sequences during teardown).
- Audit the background-thread spawn (`spawn_refresh` line 438) —
  the channel receiver may be dropped while the bg thread is
  mid-FFI call. Add explicit join or detach with cancellation.
- Wrap `main()` body in `catch_unwind` so a panic during teardown
  still restores terminal state before propagating.
- Single PR with these defensive changes. NO new tests (the bug
  is interactive-shutdown-only; tests would be ceremony).

### B (operator)

- Run `memphis tui`, wait for it to refresh, then exit (`q` or
  Ctrl-C). Repeat 5-10 times. Capture:
  - Does "Segmentation fault" still appear at the prompt?
  - Does `coredumpctl list` show new `memphis-tui` cores?
  - If yes: `coredumpctl info <pid>` first 10 stack frames →
    paste back here.

### C (mine)

- If SEGV gone: write a brief regression note + close.
- If SEGV persists: identify the new dropping suspect from the
  fresh stack, iterate.

### Done when

- 10 sequential `memphis tui` enter/exit cycles produce zero
  coredumps on operator's machine.

---

## Sprint S4 — Daemon SEGV post-#588 monitoring

**Goal.** Confirm PR #588 (kartograf shutdown stopper) closed the
shutdown-SEGV pattern. If it didn't, identify the next native
binding to bisect.

### A (mine)

- Wait 24 h. Pull every preserved coredump captured in that
  window. Compare signatures (V8 JIT offset, frame #11 symbol).
- If signature still matches pre-#588 (`...5e2`): we missed the
  real native binding; the next bisect step is to selectively
  disable `onnxruntime-node` (MEMPHIS_KARTOGRAF_ENABLE=0), restart,
  see if shutdown-SEGV still fires. If yes, suspect moves to
  `@huggingface/transformers` or `better-sqlite3`. If no, kartograf
  cleanup is incomplete (e.g. the singleton's tokenizer isn't
  released).
- If signature differs: progress — surface the new offset +
  propose next stopper to add.

### B (operator)

- Routine: do at least 3 daemon restarts during the 24 h window
  so we have multiple shutdown samples. Report any visible-to-user
  symptom (slower restart, missing reply, tier-3 dropped).

### C (mine)

- Write `feedback_segv_resolution_<date>.md` memory note with
  signature comparison.
- If different suspect emerges: open follow-up PR with the next
  stopper registration.

### Done when

- 24 h with at least 3 graceful restarts produces either zero
  SEGVs OR SEGVs with a different signature that points
  unambiguously at the next contributor.

---

## Out of scope for this sprint set

- **Kartograf v2 model retrain** (recall@10 = 0.27 baseline could
  be much better). Tracked separately — kartograf training is
  being worked on by another agent per operator 2026-05-12.
  Anti-isolation rule applies: do NOT open a parallel
  `feat/kartograf-*` branch without coordinating first.
- **Vault pepper atomic re-encrypt** — proven phantom (see PR #584).
  Stays closed unless a new pepper-encrypted artifact lands.
- **Fresh-install validation as CI gate** — the script ships (#582);
  wiring it into `.github/workflows/ci.yml` is a separate small PR
  (open it once an operator green-lights the +30 s CI cost).

## Sprint cadence

- S1 + S2 are research-heavy: A part takes ~30 min each, can run
  back-to-back same session. Operator B-step can happen at any
  later time without blocking other work.
- S3 needs operator at the keyboard for B; cannot run in parallel
  with operator absence.
- S4 is calendar-bound (24 h observation window). A-step starts
  passively after #588 merge.

## Coordination — who owns what

| Sprint | A (code/analysis) | B (review/observe) | C (iterate) |
|---|---|---|---|
| S1 confab | agent | operator | agent |
| S2 latency | agent | operator | agent |
| S3 TUI SEGV | agent | operator | agent |
| S4 daemon SEGV monitor | agent (passive) | operator (active restarts) | agent |

If an operator-only item lands (e.g. MiniMax API key in vault, a
new direction), the agent moves it to the appropriate sprint's B
section and stops attempting it until operator unblocks. No more
"shoot in the dark" coding without operator's B-step.
