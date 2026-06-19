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

## Sprint S5 — Memphis self-coding loop (operator request 2026-05-12)

**Goal.** Memphis can actually code itself. Today `memphis_self_modify`
writes a file + runs tests + commits in one tool call, which collapses
to "Memphis writes one file" because the model can't fit a multi-file
feature into a single tool invocation. Real self-coding needs a
multi-turn plan/execute/verify loop with durable state between turns.

### Architectural gaps to close

| Gap | Why it blocks self-coding today |
|---|---|
| No durable plan storage | Memphis "forgets" the plan between turns; each turn starts from scratch on the operator's last message. |
| `memphis_self_modify` is all-or-nothing | Operator asks for "5-file feature", Memphis writes file 1, tests pass, but the next turn doesn't know what file 2 was supposed to be. |
| No iterative test → fix loop | If tests fail, Memphis sees the error but has no structured way to log "step 2 attempt 1 failed because of X, try Y" so attempt 2 builds on attempt 1. |
| PR open is manual | Operator-side: agent finishes, then operator runs `gh pr create`. Should be agent-side via tool. |
| No self-review pass | Memphis commits without a "did I miss anything" gate. Codex catches things Memphis didn't. Memphis should too. |
| No deploy verification | Per A/B/C: A-step requires the change to land in operator runtime. Self-coding agent needs to verify its own deploy. |

### A — code (agent, multi-PR sprint)

**A.5.1. Durable plan storage.**

New module `src/modules/self-coding/plan-store.ts`. JSON file at
`~/.memphis/state/self-coding-plans.json` (matches tier3-session-
persistence shape: atomic write, chmod 0600, expire-on-load). Records:

```ts
type SelfCodingPlan = {
  id: string;                    // 'plan-2026-05-12-...'
  goal: string;                  // operator's original ask
  steps: Array<{
    idx: number;
    description: string;
    status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
    artifact?: string;           // path/PR/sha that step produced
    attempts: number;
    lastError?: string;
  }>;
  status: 'planning' | 'executing' | 'reviewing' | 'pr-open' | 'done' | 'cancelled';
  createdBy: 'memphis' | 'operator';
  createdAt: string;
  branch?: string;
  prUrl?: string;
};
```

**A.5.2. Plan tools.** Three new MCP tools, all tier-1 read except
`_create` and `_advance` (tier-2):

- `memphis_self_plan_create({goal, steps[]})` → returns plan_id.
- `memphis_self_plan_get({plan_id})` → returns full plan + next pending step.
- `memphis_self_plan_advance({plan_id, step_idx, status, artifact?, error?})` →
  marks one step's status + bumps `attempts`.
- `memphis_self_plan_cancel({plan_id, reason})` → end-of-line.

Anti-confab rule F: if the LLM claims "step 3 done" without a matching
`_advance` call, the gateway flags it. (Mirrors rule E for fake tool
names.)

**A.5.3. Refactor `memphis_self_modify` to step-aware mode.**

Today's surface stays for one-shot edits. Add `plan_id + step_idx`
optional fields. When set, the tool:

  - Reads plan, validates step is `pending` or `failed` (retry).
  - Writes files in this step only (not the entire feature).
  - Runs the test scope this step declared (subset, not full suite).
  - On success: marks step `done` + records the dist sha.
  - On failure: marks step `failed`, records error message, returns
    structured `{ok:false, step_idx, error, suggested_next_action}`.

Per-step idempotency: running `memphis_self_modify` twice for the
same `(plan_id, step_idx)` produces the same result (overwrites
same files, re-runs same tests).

**A.5.4. Self-review tool.**

`memphis_self_review({plan_id})` runs before PR open:

  - Reads every step's `artifact` (files touched).
  - For each, computes a checklist:
    - Lint clean? (`npx eslint <files>`)
    - Typecheck clean? (`npx tsc --noEmit`)
    - Tests touching this file pass?
    - Any TODO/FIXME left behind that wasn't in the goal?
    - File mentioned in the plan but never written? (gap detection)
    - File touched but not in any plan step? (scope creep)
  - Returns `{ok, checklist, blockers[]}`. Memphis must fix blockers
    before `_pr_open`.

**A.5.5. PR open from agent side.**

`memphis_self_pr_open({plan_id})` requires `status='reviewing'` AND
review passed. Runs:

  ```bash
  git push -u origin <branch>
  gh pr create --title "$goal" --body "<plan summary + step diffs>"
  ```

Records `prUrl` + sets status `pr-open`. Returns the PR url so the
next turn knows where the work landed.

**A.5.6. Deploy verification.**

`memphis_self_deploy_verify({plan_id})` for the C-step lane: after
operator merges the PR, Memphis runs this to confirm the change is in
the runtime. Reads:

  - `git log -1 main` matches the merged PR head.
  - Daemon main pid's binary mtime ≥ last build.
  - Expected new log line (declared in the plan) appears in
    `journalctl --user -u memphis --since "<last restart>"`.
  - Tool count from `memphis_self_describe` matches plan's expected
    delta.

Sets plan `status='done'` only if all four checks pass.

### B — operator (live test)

After A.5.1-A.5.5 ship:

1. Operator: `"Memphis, dodaj nowy tool memphis_weather który zwraca pogodę z otwartego open-meteo API"`
2. Memphis SHOULD:
   - `memphis_self_plan_create` with 6 steps (tool registry entry → impl file → executor wire → mcp server wire → test → update test counts).
   - One step at a time, run `memphis_self_modify` per step, advance plan.
   - After all steps: `memphis_self_review`. Fix blockers.
   - `memphis_self_pr_open` → returns PR url.
3. Operator reviews PR, merges.
4. Operator: `"Memphis, sprawdź czy weather wszedł"`
5. Memphis: `memphis_self_deploy_verify` → confirms `tools=N+1` + log line.

What we're looking for in B:

  - Does Memphis stay on plan across 6+ turns?
  - Does it recover from a failed test (step.attempts > 1)?
  - Does self-review catch real issues (typo, missed wire) or hallucinate?
  - Does the PR look like a real human PR or a mess?

### C — iterate (agent, scoped to B's findings)

Likely follow-ups:

  - If Memphis loses plan mid-execute: tighten the system prompt to
    explicitly call `_plan_get` at turn start.
  - If self-review hallucinates checks passing: add tool-result
    verification to the review (call the linter, don't trust the
    LLM's word for "passes").
  - If PR body is garbage: ship a `pr-template-self-coded.md` that
    self_pr_open populates.

### Why this matters

The "Memphis auto-evolution" pitch in the public-facing docs has
always been partly aspirational — `memphis_self_modify` works for one
file, but real features are 3-7 files, plus tests, plus PR
narrative. Without the plan/review/verify scaffolding, Memphis can
"start" a feature but can't finish one without operator hand-holding.

This sprint closes that gap by giving Memphis the same A/B/C discipline
the agent stack runs under — durable plan, multi-turn execution,
self-review, deploy verification. The operator's role becomes
"propose feature + merge PR + observe deploy" instead of "drive
every file write".

### Done when

- Memphis successfully ships a 3+ file feature (e.g. memphis_weather
  tool) through the full plan/execute/review/PR/verify loop without
  operator intervention beyond `merge` button.
- The operator's "Memphis, dodaj X" workflow consistently lands working
  PRs that pass CI on the first attempt 80%+ of the time. (Operator
  fixes the rest via comment, Memphis iterates.)

### Out of scope

- **Self-merge of own PRs.** Memphis NEVER merges its own work — the
  human review step is the safety bar. Codex review on the PR is also
  preserved.
- **Self-modify of native crates** (Rust). Phase 1 ships for TS only.
  Rust self-modify needs cargo check + cross-arch concerns; defer.
- **Self-deploy without operator merge.** Same safety reason.

### Timing

This is the biggest sprint in the queue:

  - A.5.1 + A.5.2 (plan store + tools): ~3 h
  - A.5.3 (refactor self_modify): ~3 h
  - A.5.4 (self_review): ~2 h
  - A.5.5 + A.5.6 (PR open + deploy verify): ~2 h
  - Tests: ~3 h
  - Total: ~13 h focused, probably 2-3 sessions

S1-S4 ship first; S5 starts once the smaller sprints are landed and
operator has bandwidth to drive the live B-step (which is itself a
multi-turn conversation).

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
