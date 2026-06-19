# Memphis skill-creation friction — improvements proposal

**Observed 2026-05-11 ~23:55-23:59:** Memphis Agent autonomously composed + installed 2 skills (`daily-brief`, `telegram-insights-push`). Manifests are well-structured. Multiple tool errors during composition but all caught by infrastructure. Net result: 2 working skills.

This doc analyses friction points and proposes concrete improvements.

---

## 1. What Memphis used (current path)

Memphis has **no first-class skill tools**. It composed skills via:

1. `memphis_fs_write` → write JSON to `~/.memphis/skills/drafts/<id>/manifest.json`
2. `memphis_exec` → run `memphis skills install <id>` via shell
3. (optional) `memphis_fs_write` → write `SKILL.md` companion file

Result: works but every error is shell-level (stderr, exit code) rather than structured. No introspection on schema mismatch. No fuzzy-match on tool names.

## 2. Friction points observed

| Friction | Symptom | Root cause |
|---|---|---|
| **Schema confusion** on `memphis_soul_write` | 2 turns wasted swapping array↔string types | Tool error message says "expected string, received array" but doesn't show correct sample |
| **Hallucinated tool name** `memphis_TTS_ON_TEXT` | Anti-confab Phase 3 caught + flagged | No "Did you mean..." fuzzy match against actual tool list |
| **Path-gate hits** on `~/.memphis/chains/...` | 3 tool calls denied | Memphis tried to read its own chain blocks via raw file APIs instead of canonical `memphis_recall` / `memphis_chain_query` |
| **Skill validation only after install** | If schema bad, has to uninstall + retry | `memphis skills validate --file` exists but Memphis didn't know about it |
| **Manual cron wiring** | Skill mentions "cron trigger 08:30" but cron task NOT auto-registered | Manifest has no `schedule.cron` field; installer doesn't register cron |
| **No skill-side dry-run** | Memphis can't test workflow without invoking it for real | No `memphis skills test <id>` |

## 3. Proposed improvements (priority order)

### P0 — `memphis_skill_*` first-class tools

Replace shell-out via `memphis_exec` with structured tool calls. Tools to register in `src/gateway/tool-registry.ts`:

```ts
memphis_skill_create({ id, name, description, tools, workflow, ... }) → draftPath
memphis_skill_validate({ id }) → { ok: true } | { ok: false, errors: [...] }
memphis_skill_install({ id }) → { ok: true, installedPath } | { ok: false, errors }
memphis_skill_list() → [{ id, name, installed, ... }]
memphis_skill_show({ id }) → full manifest + status
memphis_skill_test({ id, dryRun: true }) → workflow trace without LLM/tool execution
```

Schema-typed inputs prevent the array-vs-string class of mistake. Tool descriptions teach Memphis the manifest shape.

**Effort**: ~300 LOC TS (single PR). Mirrors `memphis_app_*` pattern.

### P1 — Schema error messages with correct-shape sample

Today: `invalid updates.context.activeWork: expected string, received array`
Better: include sample:
```
invalid updates.context.activeWork: expected string, received array
Correct shape: {"updates":{"context":{"activeWork":"installing voice bridge"}}}
List-shape fields: recentDecisions, openQuestions, blockers (use array of strings).
String-shape fields: activeWork, goal, agentName (use single string).
```

**Effort**: ~50 LOC in `memphis_soul_write` handler (extend error from zod issue → human-readable + example).

### P1 — Fuzzy-match on unknown tool names

When Memphis hallucinates `memphis_TTS_ON_TEXT` (anti-confab caught), system response can suggest closest matches:

```
Confabulation detected: memphis_TTS_ON_TEXT (no such tool).
Did you mean: memphis_voice_speak? Most likely intent: synthesize text to audio.
Available voice tools: memphis_voice_speak, memphis_media_ingest, memphis_voice_health.
```

Use Levenshtein distance against all tool names; surface top 3 within edit-distance ≤ 5.

**Effort**: ~80 LOC; add to anti-confab Phase 3 hook that emits the warn-append footer.

### P2 — Manifest `schedule` field + auto-cron registration

Add optional `schedule` field to manifest schema:
```json
{
  "schedule": {
    "cron": "30 8 * * *",
    "timezone": "Europe/Warsaw",
    "skipIfUnhealthy": true
  }
}
```

Skills installer (`memphis skills install <id>`) reads this and registers a scheduler task automatically. Memphis declares ONCE; no separate `memphis schedule add ...` step.

**Effort**: ~150 LOC — manifest schema bump + install handler + scheduler registration. Backward-compat: missing `schedule` = no auto-cron.

### P2 — `memphis_skill_test` dry-run

Workflow array is currently free-form prose. To make it testable, parse it as a sequence of tool calls + assertions:

```json
"workflow": [
  { "step": "fetch_weather", "tool": "memphis_web_fetch", "args": {...}, "store": "weather" },
  { "step": "fetch_news", "tool": "memphis_web_search", "args": {...}, "store": "news" },
  { "step": "compose", "tool": "memphis_journal", "args": { "content": "{{weather}}+{{news}}" } }
]
```

`memphis_skill_test` runs the workflow with mock tool outputs, validates that all referenced tools exist + arg shapes are valid. Catches workflow bugs before first cron fire.

**Effort**: ~400 LOC (workflow parser + mock runner). Bigger lift — defer until P0/P1 land.

### P3 — Skill examples in system prompt

Currently Memphis composes manifests from scratch. Could include 1-2 EXAMPLE manifests in system prompt under "skills patterns" section. Just exemplars; not templates Memphis must copy verbatim.

**Effort**: ~30 lines in `src/gateway/system-prompt.ts`. Trade-off: +tokens per turn.

## 4. What NOT to change

- ✅ Manifest schema itself — Memphis's outputs validate, structure is good
- ✅ Drafts dir / installed dir workflow — clean separation, reversible
- ✅ Tool gating on `~/.memphis/chains/` — keep raw chain blocks behind canonical recall tools; Memphis should NOT need to bypass this. If it does (debugging), surface a proper `memphis_chain_inspect(chain, index)` tool instead.

## 5. Quick wins (operator can do today)

- Set `MEMPHIS_ANTICONFAB_PHASE=3` — already done; catches fake tool names like `memphis_TTS_ON_TEXT`
- After `memphis skills install <id>`, run `memphis skills validate <id>` ← actually that's missing — currently `validate` is `--file <path>` only, doesn't take id. Worth adding `validate <id>` form for installed skills.
- Pin daily-brief + telegram-insights-push to cron: `memphis schedule add ...` (manual until P2 lands)

---

## 6. Rollup — which 3 to implement first

**Order**:
1. **P0 `memphis_skill_*` tools** — biggest leverage, removes shell-out path
2. **P1 schema errors with sample** — saves 2-turn round-trips on type mismatches
3. **P2 manifest `schedule` field + auto-cron** — closes the "skill installed but never runs" gap operator may not notice

Time est: 1-2 days total. Could be Memphis self-modify candidate (TS-only, additive, env-gated for testing). Operator-supervised single-PR delivery.
