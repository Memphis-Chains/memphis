# TUI Refactor — Full Cleanup Plan

> Status note:
> This document captures immediate TUI cleanup and refactor groundwork from the Sprint 3/4 context.
> In the canonical roadmap, this maps to historical/groundwork `TUI-A`, not the future product-aware TUI milestones.
> For canonical TUI timing and later phases (`TUI-B`, `TUI-C`, `TUI-D`), use `docs/EXECUTION-PLAN.md`.
>
> **Roadmap alignment:** All items map to Sprint 3 issues (Phase 3 P2 / Phase 4 P3).

## Context

The TUI has accumulated dead screens, dead code, and type mismatches that make it misleading and fragile. Sprint 3 has already closed several issues; this plan closes the remaining TUI items in the roadmap:

| Roadmap item | Description | Priority | Status |
|---|---|---|---|
| 6.8 | `use-provider-health.ts` dead code | P2 MEDIUM | Open — delete |
| 7.1 | `decision-screen.ts` never rendered | P3 LOW | Open — wire up |
| 7.2 | `execLimiter` unused | P3 LOW | **Already resolved** — `execLimiter.check(key)` is called in `src/gateway/server.ts:252`. No action needed. |
| 7.3 | Hardcoded version in dashboard HTML | P3 LOW | **Already resolved** — `getAppVersion()` in `src/config/paths.ts` reads from `package.json` dynamically. No action needed. |
| 7.5 | `ProviderName` excludes `glm`/`minimax`/`deepseek` | P3 LOW | Open — fix types |

---

## Phase 1 — Wire Decision Screen (ROADMAP 7.1)

### Decision storage
Decisions are stored in `data/decision-history.jsonl` (JSONL, one `DecisionHistoryEntry` per line), not in chain block files. The path is resolved via `MEMPHIS_DATA_DIR` environment variable.

**`DecisionRecord` shape** (`src/core/decision-lifecycle.ts`):
```typescript
type DecisionRecord = {
  id: string;
  title: string;
  context?: string;
  options: string[];
  chosen?: string;
  confidence: number;
  status: DecisionStatus;
  createdAt: string;
};
```

**`Decision` type** expected by existing `renderDecisionScreen`:
```typescript
type Decision = { hash: string; question: string; choice: string; };
```

**Mapping:** `hash → id`, `question → title`, `choice → chosen ?? options[0]`

### Files to change

**`src/tui/screens/decision-screen.ts`**
- Add `loadDecisionsFromChain(): Promise<Decision[]>` — reads `data/decision-history.jsonl` via `readDecisionHistory()` from `core/decision-history-store.js`, maps `DecisionHistoryEntry → Decision`. Path resolved using `getDataDir()` from `config/paths.js`.
- `loadDecisionScreen(loadDecisions)` — keep the signature, make `loadDecisions` call `loadDecisionsFromChain()` internally.

**`src/tui/index.ts`**
- Add `import { loadDecisionScreen, renderDecisionScreen } from './screens/decision-screen.js'`
- Add a `rightPanelLines` branch for `screen === 'decisions'` showing help text
- Add `/decisions list` command: reads via `loadDecisionScreen`, stores in `TuiState`, renders
- Add `'decisions'` to the tab bar (line 138) and Ctrl+Tab cycling (line 643)

**`src/tui/core.ts`**
- Keep `'decisions'` in `TuiScreen` union, `normalizeScreen` and `keybindToScreen`

---

## Phase 2 — Remove 6 Dead Screen Declarations

**`src/tui/core.ts`**
- Remove from `TuiScreen` union: `'backup'`, `'cognitive'`, `'sync'`, `'mcp'`, `'debug'`
- Remove from `normalizeScreen` array: same 5 values
- Remove from `keybindToScreen`: no bindings for these

**`src/tui/index.ts`**
- Line 138 tab bar: keep only `['dashboard', 'chat', 'health', 'embed', 'vault', 'decisions']`
- Line 643 Ctrl+Tab: same 6-element list

---

## Phase 3 — Delete Dead Code (ROADMAP 6.8)

**`src/tui/hooks/use-provider-health.ts`** — **Delete file**. Zero imports across the entire `src/` tree.

---

## Phase 4 — Fix ProviderName Type Mismatches (ROADMAP 7.5)

**4a. `src/core/types.ts`**
```typescript
// Before
export type ProviderName = 'shared-llm' | 'decentralized-llm' | 'local-fallback' | 'ollama' | 'glm';
// After
export type ProviderName = 'shared-llm' | 'decentralized-llm' | 'local-fallback' | 'ollama' | 'glm' | 'minimax' | 'deepseek';
```

**4b. `src/tui/index.ts`** — Accept all providers in `/provider` command (lines ~895–909)
Add `'glm'`, `'minimax'`, `'deepseek'` to the hardcoded validation list.

**4c. `src/infra/http/contracts.ts`** — Fix Zod schema (line ~40)
Update `providersHealthResponseSchema`: add `'glm'` to both `defaultProvider` and `providers[].name` enums.

**4d. `src/providers/capability-matrix.ts`**
Add entries for `glm`, `minimax`, `deepseek`. Models: `minimax` → `['MiniMax-M2.7', 'abab5.5-chat', 'abab6-chat', 'abab6.5s-chat']`, `glm` → from `GlmProvider.listModels()`, `deepseek` → `['deepseek-chat']`.

---

## Phase 5 — Add Generation Status Bar Above Input (UX Enhancement)

### Where
Between the bottom border and the `rl.question()` input prompt. Compact single line showing live generation state.

### What it shows
```
[⏳ 3s]  [step 2/32]  [provider ollama]  [ctx ████░░░░ 56%]  [sync ✓]
```

| Segment | Source | Idle state |
|---|---|---|
| **Thinking timer** `⏳ Xs` | `generatingSince` timestamp | hidden |
| **Loop step** `[step N/32]` | `result.trace?.attempts?.length ?? 1` | hidden |
| **Provider badge** | `state.provider` | `[provider xxx]` always |
| **Context meter** `[ctx ████░░ 56%]` | `state.chatMessages.length / MAX_MESSAGES` (40) | `[ctx ░░░░░░ 0%]` |
| **Sync indicator** `[sync ✓]` | `syncAdapter?.getStatus()` | `[sync -]` |

### Files to change

**`src/tui/index.ts`**

1. Add to `TuiState`:
   ```typescript
   generatingSince?: number;   // Date.now() when generation started
   lastStep?: number;         // attempts.length from last trace
   ```

2. Add `renderStatusBar()` function (reuses `FG_COPPER`, `FG_TEAL`, `FG_STEEL` from theme).

3. Before generation starts (before spinner interval):
   ```typescript
   state.generatingSince = Date.now();
   state.lastStep = undefined;
   ```

4. On result received:
   ```typescript
   state.generatingSince = undefined;
   state.lastStep = result.trace?.attempts?.length ?? 1;
   ```

5. Render status bar after bottom border, before `rl.question()` prompt.

---

## Verification

```bash
npm run typecheck && npm run lint
npm run test:ts -- --grep "tui\|decision\|provider" 2>/dev/null || true
```

---

## Files Summary

| File | Change |
|------|--------|
| `src/tui/screens/decision-screen.ts` | Add `loadDecisionsFromChain()` using `readDecisionHistory()` from `core/decision-history-store.js`; map `DecisionHistoryEntry → Decision` |
| `src/tui/index.ts` | + decision screen import; + `/decisions` command; + `decisions` to tab/ctrl-tab nav; + `glm/minimax/deepseek` in `/provider`; + `generatingSince`/`lastStep` state; + `renderStatusBar()`; status bar between bottom border and input |
| `src/tui/core.ts` | Keep `'decisions'`; remove 5 dead screens from union + nav |
| `src/tui/hooks/use-provider-health.ts` | **Delete** |
| `src/core/types.ts` | Add `'minimax'`, `'deepseek'` to `ProviderName` |
| `src/infra/http/contracts.ts` | Add `'glm'` to `providersHealthResponseSchema` enums |
| `src/providers/capability-matrix.ts` | Add `glm`, `minimax`, `deepseek` entries |
