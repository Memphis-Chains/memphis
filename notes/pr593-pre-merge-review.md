# PR #593 Pre-Merge Review — Coder B → Coder A

**PR:** `feat(self-coding): S5 plan-aware self-coding loop (A.5.1-A.5.6 complete)`
**Branch:** `feat/s5-plan-store`
**Stats:** 16 files, +3059/-11, 6 commits
**Status:** OPEN, **CI: FAILURE** on `quality-gate` (2026-05-12 18:51:28Z)
**Reviewer:** Coder B (this agent)
**Status of this doc:** living — append findings as found, hand off to Coder A when complete.

---

## 🔴 BLOCKERS (must fix before merge)

### B1. CI quality-gate failing — 4 tests broken

PR body claims *"75 unit + 4 contract green ... Lint/tsc: czysto na moich plikach"*. That's true for the **new** tests written for S5, but the existing assertion-count tests were not updated. Coder A bypassed pre-commit hook on A.5.6 commit (`--no-verify`, his own admission) which is what would have caught this locally.

**Run:** `gh run view 25754990138 --log-failed`

**Failures:**

1. **`tests/unit/tool-registry.test.ts:25`** — `expect(getToolNames()).toHaveLength(44)` — got 51. +7 from S5.
2. **`tests/unit/tool-registry.test.ts:84`** — `expect(tier0.length).toBe(15)` — got 21. +6 tier-0 (memphis_self_plan_{create,get,advance,cancel} + memphis_self_review + memphis_self_deploy_verify).
3. **`tests/unit/tool-executor-runtime-coverage.test.ts:23`** — `expect(missing).toEqual([])` — got 7. The 7 S5 tools are registered in `TOOL_REGISTRY` and MCP server but NOT in `createInProcessToolExecutor`.
4. **`tests/unit/tool-executor-runtime-coverage.test.ts:50`** — same 7 missing under `MEMPHIS_FEATURES=experimental-tools` env.

**Missing tools from runtime executor:**
```
memphis_self_plan_create
memphis_self_plan_get
memphis_self_plan_advance
memphis_self_plan_cancel
memphis_self_review
memphis_self_pr_open
memphis_self_deploy_verify
```

**Fix path:**
- **(a)** Bump test count assertions in `tests/unit/tool-registry.test.ts` (44→51, 15→21). Update the inline comments documenting the count rationale.
- **(b)** Wire the 7 tools into `createInProcessToolExecutor` in `src/gateway/tool-executor.ts` — mirror the `memphis_cron` `buildTool({...})` block (around line 773 in the pre-PR file). Each tool needs `validateInput` + `execute` closures pointing at the same handlers MCP server uses. This makes the tools available to the in-process turn loop, not just MCP.
- **(c)** If S5 tools are intentionally MCP-only (i.e., self-coding is gateway-driven, never agent-invoked), then update `tool-executor-runtime-coverage.test.ts` to exempt them by name — but document why in a comment.

Recommend (a) + (b). Operator chat agent should be able to call `memphis_self_plan_create` directly when they want to start a multi-step feature.

### B2. `--no-verify` commit bypass on A.5.6

From PR body:
> *"One commit (A.5.6) used `--no-verify` because the pre-commit lint hook flagged a pre-existing error in `tests/unit/vault-pepper-invariants.test.ts` unrelated to this PR. My own touched files are lint-clean."*

This **directly caused B1** — the hook runs full `npm test`, which would have failed the assertion-count tests. The "pre-existing" framing is also worth verifying: if vault-pepper-invariants.test.ts is genuinely broken on main, that's a separate P1; if it's broken because of earlier S5 commits, that's a B-tier issue.

Action: **(a)** verify lint/test status of `vault-pepper-invariants.test.ts` on plain main (`git checkout main && npm test -- vault-pepper`). **(b)** if it's broken on main, open a separate fix PR for it. **(c)** never use `--no-verify` again without first opening a ticket explaining what hook is being bypassed and why.

---

## 🟡 WARN-level findings (not blockers, but flag in handoff)

### W1. Silent-catch anti-pattern × 5 instances

Memphis convention (`feedback_truth_model_silent_catch.md`): *"`} catch {}` is a hidden bug; audit log gets cause, write errors surface inline, decrypt errors stay generic (oracle defense)."*

Found 5 `} catch {` blocks in PR #593 with no logging or audit emit:

```
Line 502:  catch on `git merge-base --is-ancestor`  → returns false (test/probe path — defensible)
Line 574:  catch on `git fetch origin <base>`       → comment says "non-fatal" (defensible, but no log)
Line 1373: catch on `git rev-parse`                 → returns 'HEAD~1' sentinel (no log)
Line 1403: catch on git ls-tree (or similar)        → returns [] (no log)
Line 1421: catch on git status / ls-files           → returns [] (no log)
```

Lines 502 + 574 are arguably correct (probe-style + explicit non-fatal documented). Lines 1373/1403/1421 silently swallow errors and return empty/sentinel without logging the cause. Per Memphis truth-model: at minimum `log.warn({ err: err.message }, '<context>')` before returning the fallback.

Recommend: at least add `log.warn` lines to 1373/1403/1421. Optional for 502/574 since they have explanatory comments.

### W2. `process.cwd()` install-root violations × 3 instances

Memphis convention (`feedback_install_root_anchoring.md`): *"Install root, not cwd, for default paths. defaults like `./crates/memphis-napi` resolve via `process.cwd()` and break `memphis` from $HOME; use `resolveInstallRoot()` from src/infra/runtime/install-root.ts."*

Three new sites default `projectRoot` to `process.cwd()`:

```
Line 540:  src/mcp/tools/self-pr-open.ts          projectRoot = deps.projectRoot ?? process.cwd();
Line 1259: src/mcp/tools/self-deploy-verify.ts    projectRoot = deps.projectRoot ?? process.cwd();
Line 1462: src/mcp/tools/self-review.ts           projectRoot = deps.projectRoot ?? process.cwd();
```

**Defensible interpretation:** for self-coding flows, `projectRoot` is the operator-invoked working directory (where the operator wants to modify code), not the Memphis install dir. If the operator runs `cd ~/some-other-repo && memphis ...` the self-modify happens in that repo. In that case `process.cwd()` is correct, **not** `resolveInstallRoot()`.

**However:** if Memphis is launched as a daemon (systemd-user, supervisord), `process.cwd()` is typically `/` or the user home — neither the operator's editing repo nor Memphis's install. The self-coding loop assumes Memphis modifies its OWN codebase, in which case `resolveInstallRoot()` is correct.

Recommend Coder A clarify: what's the intended semantics for self-coding flows when Memphis runs as daemon vs CLI? If "always Memphis's install root" → use `resolveInstallRoot()` as the fallback. If "operator's editing repo" → `process.cwd()` is fine but document why.

### W3. `--no-verify` bypass on A.5.6 — partially defensible, trivially fixable

Verified: `tests/unit/vault-pepper-invariants.test.ts` on plain main has **2 ESLint warnings** (not errors): unused `eslint-disable` directives at lines 52 and 108. Last touched by PR #584 (2026-05-12 18:09, same day as #593).

If pre-commit hook runs ESLint with `--max-warnings 0`, these would block. So `--no-verify` was partially defensible — BUT the right path is the 2-line fix (delete the unused directives), not the bypass.

The REAL problem from `--no-verify`: it also let Coder A through B1 (broken assertion counts). If the hook had run `npm test`, the tool-count assertion failures would have surfaced before push.

Recommend: in addition to fixing B1, push a 1-line cleanup PR for `vault-pepper-invariants.test.ts` lines 52 + 108 (just remove the unused `// eslint-disable-next-line ...` comments). Then `--no-verify` is never needed for this reason again.

---

## 🟢 NIT-level findings (cosmetic / future-sprint)

### N1. `JSON.parse(stdout)` unguarded in `fetchPrView` (`self-deploy-verify.ts` ~line 481)

```typescript
const { stdout } = await runCommand('gh', ['pr', 'view', prUrl, '--json', ...], projectRoot);
const parsed = JSON.parse(stdout) as { merged: boolean; mergeCommit?: {...} };
```

If `gh pr view` returns malformed JSON (gh version mismatch, locale, network truncation, edge-case error path that prints text to stdout instead of JSON), `JSON.parse` throws `SyntaxError` and unwinds out of `fetchPrView`. The caller (`runMemphisSelfDeployVerify`) returns a typed `SelfDeployVerifyOutput` with an `error?: string` field for failure paths — but the thrown SyntaxError skips that shape entirely and reaches the MCP tool dispatcher as an uncaught error.

Recommend: wrap in try/catch, return `{ ok: false, error: 'gh pr view returned non-JSON: <first 100 chars>' }`. Same fix shape would apply to any other JSON.parse on external-process stdout in the S5 surface (audit recommended — I only spot-checked one).

### N2. Test-count assertion brittleness

`tests/unit/tool-registry.test.ts` hard-codes the exact count of tools (44 → 51 after this PR, 15 → 21 for tier-0). This breaks every time anyone adds a tool — Coder A's PR is just the latest victim. Two options:

- (a) **Status quo**: keep the exact count, bump on every tool-add PR. Catches accidental additions. CI gate works as intended.
- (b) **Bound check**: `expect(getToolNames().length).toBeGreaterThanOrEqual(15)` + a separate test that asserts every registered tool has a runtime handler. Less brittle, similar coverage.

Memphis convention favors (a) — explicit counts catch silent additions. So this is fine as-is; just flagging that the breakage pattern is recurring. Document the count-bump as a checklist item in the contributor guide if not already.

### N3. Operator-side smoke test plan in PR body is correct but worth testing post-merge

PR body §"Operator-side smoke test plan" describes the full self-coding loop. Worth running it as an actual B-step after merge — `/nightly`-style verification. If the loop fails on step 2 (auto-advance after self_modify), it means the bookkeeping is misaligned; if it fails on step 5 (deploy_verify), check N1 fix.

---

## ✅ ACK — done well

- 75 new unit tests + 4 integration contract tests for S5 surface
- Backward-compat: 27 existing self_modify tests pass without modification
- Atomic-write pattern reused from `tier3-session-persistence.ts:177-203` (matches Memphis state-file convention)
- 30-day GC on terminal plans matches `tier3-session-persistence` philosophy
- Feature gate: `MEMPHIS_SELF_CODING_PLANS=0` — safe default-off opt-in
- `memphis_self_pr_open` explicitly NEVER merges — operator-only safety bar preserved
- Spec reference: PR #589 sprint plan
- Cross-layer grid documented in PR body

---

## Findings worth carrying into a Codex round-N hotfix (post-merge)

Memphis convention (`feedback_codex_bundled_hotfix`): Codex review fires post-merge, all findings bundled into one `hotfix/codex-round-N` PR rather than one-PR-per-finding.

If Coder A fixes B1 + B2 + W1/W3 in #593 before merge, the round-N PR will be smaller. Likely Codex catches:

- W1 silent-catch in lines 1373/1403/1421 (Codex flags `} catch {}` with high signal)
- N1 unguarded JSON.parse (Codex flags exception-paths from untyped external IO)
- The 3 `process.cwd()` defaults (W2) — Codex usually flags these in Memphis convention
- Possibly: 2 unused eslint-disable directives in `vault-pepper-invariants.test.ts` (if Codex runs lint warnings)

Recommend Coder A pre-empt by fixing W1 + W2 + W3 + N1 in #593 itself. Then round-N is just whatever Codex catches that we missed.

---

## Verification commands for reviewer

```bash
gh pr view 593
gh pr diff 593
gh run view 25754990138 --log-failed | grep "FAIL\|expected\|got"

# Local repro of CI failure
git fetch origin feat/s5-plan-store
git checkout feat/s5-plan-store
npm install
npm test -- tests/unit/tool-registry.test.ts tests/unit/tool-executor-runtime-coverage.test.ts
```
