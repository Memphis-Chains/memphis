# Sprint 0.5 — Prompt Injection Expansion (2026-04-22)

> **Status.** Proposed. Slots **before Phase A Sprint 1** of `watra-pretrain-sprint-plan.md`. Duration: 2 weeks. No training infrastructure needed; pure code change on existing `src/gateway/system-prompt.ts` foundation.
>
> **Trigger.** Operator insight 2026-04-22: "Memphis has bootstrap + first 4 commands — let's inject the full map there." Code audit revealed `buildSystemPrompt` **already does** Memphis-context injection (~14KB per turn), but with 6 concrete gaps that make it incomplete.
>
> **Why this sprint saves 3+ months.** Phase A pre-training assumes we need a separate model for Memphis-structure knowledge. But the primary LLM (Claude/GPT/Ollama) can *already* handle Polish, code, tool-use reasoning. It just doesn't know Memphis. If system prompt tells it everything Memphis-specific, primary LLM **functions as WatraLLM** for most use-cases. The trained WatraLLM then becomes a "smaller, faster, offline internalization" — not a capability bootstrap.

## Context — what already works

`src/gateway/system-prompt.ts:buildSystemPrompt()` generates per-turn context injection used by every primary LLM call. Architecture:

```
User turn → turn-runtime.ts:runTurnRuntime()
  → buildRuntimeSystemPrompt() in agent-runtime.ts
    → buildMemphisSystemPrompt() from system-prompt.ts     ← MAIN PROMPT
      → buildSoulManifestFragment() from soul/boot.ts      ← IDENTITY
      → buildSoulMemoryFragment() / buildSoulBootPrompt()  ← LEARNED STATE
      → buildInstalledSkillsPromptFragment()                ← INSTALLED SKILLS
    → Optional: recalled memory, cognitive context fragments
  → Primary LLM chat() call with this system prompt
```

Current output structure (~14KB):
- `<memphis_system>` XML-wrapped root
- `<soul_identity>` — ISKRA content (personalization)
- `<identity>` — agent/owner names, local-first guarantee
- `<architecture>` — chain stats, rust bridge status, block types, loop limits
- `<behavior>` — tool usage rules, prompt-security, self-modification, chain integrity
- `<tools>` — per-tool docs (CHAIN EFFECT, WHEN TO USE, SEARCH STRATEGY)
- `<cognitive_mode>` addendum (one-liner)
- `<output_format>` — response conventions

This is a **working prompt-injection system**. Sprint 0.5 **extends** it, does not replace.

## 6 gaps → 6 PRs

Each gap = 1 independently-reviewable PR. Small, Codex-friendly, revertable.

### PR #G1 — Auto-generate tool docs from registry (2-3 days)

**Problem.** `tool-registry.ts` has 37 tools. `system-prompt.ts` hand-written `<tool>` docs for 15. 22 tools available to LLM but undocumented in the prompt.

Missing: `memphis_git, memphis_test, memphis_cron, memphis_self_modify, memphis_fs_write, memphis_fs_ops, memphis_code_read, memphis_grep, memphis_glob, memphis_build, memphis_package, memphis_db, memphis_web_search, memphis_case_append, memphis_case_query, memphis_config_show, memphis_config_reload, memphis_restart, memphis_presence, memphis_cognitive_mode_set, memphis_config_set, memphis_health_check`.

**Fix.** Replace `buildToolInstructions(tools)` in `system-prompt.ts`:

- For tools with hand-authored docs in the current if-chain → keep those (richer than auto-gen)
- For remaining tools → auto-generate from `TOOL_REGISTRY[name]`:
  ```ts
  <tool name="memphis_X" tier="2" capabilities="execute,write">
  PURPOSE: {description from registry}
  INPUT: {zod schema rendered as JSON-schema-ish, OR "see tool signature"}
  OUTPUT: (inferred from handler OR "varies, check result object")
  TIER: 2 — requires vault passphrase
  CAPABILITY: execute, write — mutates state and runs commands
  </tool>
  ```
- Add helper `zodSchemaToPromptShape(schema)` — render Zod schema as human-readable input shape

**Files:** `src/gateway/system-prompt.ts` (main change), new test `tests/unit/system-prompt.tool-docs.test.ts`.

**Test.** `buildSystemPrompt({ availableTools: Object.keys(TOOL_REGISTRY) })` contains `<tool name="memphis_X">` blocks for all 37 names. Rich docs preserved for the curated 15; auto-gen docs present for the other 22.

**Ship criterion.** LLM running with this prompt asked "what can memphis_git do?" answers correctly using registry info, not "I don't know".

---

### PR #G2 — Chain catalog refactor (1-2 days, pure refactor first)

**Problem.** 3 conflicting chain lists across the codebase:

| File | Lists | Count |
|------|-------|-------|
| `~/.memphis/chains/` (reality) | journal, decisions, cases, patterns, reflections, system, collective, **insights**, **soul** | 9 |
| `src/soul/manifest.ts:19 KNOWN_CHAINS` | journal, decisions, system, reflections, cases, collective, patterns, **proactive** | 8 (different set!) |
| `src/gateway/system-prompt.ts:35 CHAINS` | journal, system, decisions, reflections | 4 (docs subset) |

**Fix.** New module `src/memory/chain-catalog.ts`:
```ts
export interface ChainDefinition {
  name: string;
  purpose: string;      // one-line description
  blockTypes: string[]; // which BlockType enum values typically land here
  writeFrequency: 'high' | 'medium' | 'low';
  consentDefault: 'exportable' | 'local-only' | 'anonymized';
}

export const CHAIN_CATALOG: Record<string, ChainDefinition> = {
  journal: { purpose: 'Persistent memory...', blockTypes: ['journal'], writeFrequency: 'high', consentDefault: 'local-only' },
  system: { purpose: 'Audit trail...', blockTypes: ['system', 'system_event', 'tool_call', 'tool_result'], writeFrequency: 'high', consentDefault: 'exportable' },
  decisions: { ... },
  reflections: { ... },
  cases: { ... },
  patterns: { ... },
  collective: { ... },
  insights: { ... },
  soul: { ... },
};

export function getChainNames(): string[] {
  return Object.keys(CHAIN_CATALOG);
}
```

Update consumers:
- `src/soul/manifest.ts:19` → import `getChainNames()` from catalog, drop `KNOWN_CHAINS` array
- `src/gateway/system-prompt.ts:35` → import `CHAIN_CATALOG`, render as docs with purpose + blockTypes
- `src/infra/cli/commands/readiness.ts` (chain check) → use catalog

**Clarify `proactive` vs `insights`** — scan disk + code, figure which is canonical, document migration if one is deprecated.

**Files:** new `src/memory/chain-catalog.ts`, edits to manifest.ts + system-prompt.ts + readiness.ts + any other consumers (grep `KNOWN_CHAINS`). New test `tests/unit/chain-catalog.test.ts`.

**Test.** `getChainNames()` returns 9 chains. `buildSystemPrompt()` output contains description for each.

**Ship criterion.** `grep -rn "KNOWN_CHAINS\|proactive" src/` → only references in chain-catalog.ts or documented migration notes.

---

### PR #G3 — Fix hardcoded path (30 minutes)

**Problem.** `system-prompt.ts:486`:
```
- Your codebase: /home/memphis_ai_brain_on_chain/memphis/
```

Old host hardcode. Real path is `/home/memphis/memphis/` on current host; varies per operator.

**Fix.** Replace with dynamic resolution:
```ts
import { resolveInstallRoot } from '../infra/runtime/install-root.js';

// In behavior section:
const installRoot = (() => {
  try { return resolveInstallRoot({ rawEnv }); } catch { return '<install root>'; }
})();

// rendered: "Your codebase: ${installRoot}"
```

Also add:
- Data dir: `resolveDotEnvPath(rawEnv)` parent or `getDataDir(rawEnv)` for `~/.memphis/`
- Install root distinct from data dir (important for operators running npm install vs source checkout)

**Files:** `src/gateway/system-prompt.ts` only. Existing unit test asserts the section doesn't contain literal `memphis_ai_brain_on_chain`.

**Ship criterion.** `grep "memphis_ai_brain_on_chain" src/` → zero matches. Fresh install on any host: system prompt contains correct install root.

---

### PR #G4 — Safety invariants block expansion (2-3 days)

**Problem.** `<behavior>` block has "Self-modification" + "Chain integrity" paragraphs but they're terse. LLM doesn't know the *mechanics* of why things are restricted — just that they are. This leads to:
- LLM proposing shell commands that trigger signed-block-gate failures (doesn't know gate exists)
- LLM writing code that ignores `.append.lock` pattern
- LLM not understanding `AutonomyMode='paranoid'` blocks actions
- LLM not understanding circuit breaker semantics
- LLM unaware of offline-invariant gate in CI (triggers when MEMPHIS_SAFE_MODE=true)

**Fix.** New `<safety_invariants>` XML block injected between `<architecture>` and `<behavior>`:

```xml
<safety_invariants>
CHAIN INTEGRITY:
- Every block has SHA-256 prev_hash pointing at previous block hash
- Block index is sequential; no gaps, no reorderings
- Blocks are signed with Ed25519 when RUST_CHAIN_REQUIRE_SIGNATURES=true
- NEVER construct a block manually; always go through memphis_journal/memphis_decide/
  memphis_case_append; they handle hashing and signing correctly

APPEND LOCK:
- File-based .append.lock in each chain directory
- Acquired BEFORE hashing + signing; released AFTER atomic rename
- Concurrent writes serialize; stale lock files are cleaned on boot
- Do not write blocks by calling chain-file-io.ts directly — use tools

OFFLINE INVARIANT GATE:
- MEMPHIS_SAFE_MODE=true blocks all network egress
- CI offline-invariant test proves fresh install boots without a provider
- If you're writing code, avoid adding network calls to the boot path

PARANOID TIER (AutonomyMode='paranoid'):
- Hardcoded in src/security/ for WatraLLM router (Q3+)
- Every tool call requires explicit operator acknowledgment
- Even "read" tools are gated — assume zero implicit capabilities

CIRCUIT BREAKER (per-provider):
- Each provider (anthropic, minimax, ollama) has CLOSED/OPEN/HALF_OPEN state
- Trips on N failures in M ms window → skips provider for cooldown period
- Cascade picks next provider automatically
- Don't try to "force" a failed provider; trust the cascade

VAULT BOUNDARY:
- Secrets live in ~/.memphis/vault-entries.json (AES-256-GCM)
- NEVER read the file directly; use memphis_soul_read or rely on env resolution
- VAULT:keyname refs in .env auto-resolve via src/infra/config/vault-resolve.ts
- Writing to vault goes through src/security/vault-boundary.ts only

SELF-MODIFY GUARDS:
- memphis_self_modify creates snapshot + branch BEFORE changes
- Tests run in isolated branch; failed tests auto-revert
- Boot-failure-counter increments on each `memphis serve`; 3 failures → auto-revert
- Counter stored in ~/.memphis/state/boot-failures.json
- DO NOT bypass via exec — always use memphis_self_modify for code changes
</safety_invariants>
```

**Files:** `src/gateway/system-prompt.ts` additions. Test verifies section is present.

**Ship criterion.** LLM asked "I want to add a new tool — what's the safe path?" now answers with snapshot + branch + test-gate flow, not raw `memphis_exec` suggestions.

---

### PR #G5 — Skills API block (1-2 days)

**Problem.** `buildInstalledSkillsPromptFragment` injects inventory ("3 skills installed: X, Y, Z" or "None installed"). But **doesn't teach LLM how to create** a skill. Skills marketplace is a shipped feature (`src/modules/skills/`) but operators can't ask "help me write a skill" because LLM lacks the API shape.

**Fix.** New `<skills_api>` block appended to `<tools>` section:

```xml
<skills_api>
Skills are packaged extensions to Memphis. Operators install them via
memphis_skills_install; agents can compose skill calls as part of tool use.

SKILL MANIFEST SHAPE (package.json-like):
{
  "name": "skill-name",
  "version": "1.0.0",
  "description": "what this skill does",
  "entry": "./dist/index.js",
  "capabilities": ["read", "write", "network"],
  "tier": 0,
  "operatorAck": false
}

SKILL ENTRY MODULE SHAPE:
export default {
  name: 'skill-name',
  register(ctx: SkillContext) {
    ctx.registerTool({
      name: 'my_tool',
      handler: async (input) => { /* ... */ },
      inputSchema: z.object({ ... }),
    });
  }
};

SKILL LOCATIONS:
- Installed: ~/.memphis/skills/<name>/
- Development: ${installRoot}/src/modules/skills/ (built-in skills)
- Marketplace: memphis_skills_browse (shipped)

WHEN TO PROPOSE A SKILL:
- Operator asks for recurring workflow (same 3 tool calls daily)
- Domain-specific need (mechanic invoicing, hobbyist project tracker)
- Integration with external service (Slack, Discord, specific API)

HOW TO SCAFFOLD A SKILL:
1. memphis_fs_ops mkdir ~/.memphis/skills-dev/my-skill
2. memphis_fs_write the manifest + entry module
3. Test in dev mode: memphis skills dev ~/.memphis/skills-dev/my-skill
4. When confident: memphis_skills_install <path>
</skills_api>
```

**Files:** `src/gateway/system-prompt.ts`, read `src/modules/skills/runtime.ts` for current manifest shape to make this accurate, new test.

**Ship criterion.** Operator asks "write me a skill that logs every commit to journal" — LLM produces valid manifest + entry code using current API, not hallucinated shape.

---

### PR #G6 — Cognitive modes expansion (1-2 days)

**Problem.** `cognitiveModeAddendum` = `"Mode B — Inferred Decisions: temp=0.5, style=deliberate, pattern=evidence"`. One-liner. LLM doesn't know:
- What other modes exist (A, C, D, E)
- When each is appropriate
- How to switch (`memphis_cognitive_mode_set`)
- What each mode expects from output

**Fix.** Replace one-liner with `<cognitive_modes>` block. Current active mode highlighted:

```xml
<cognitive_modes current="B">
Memphis has 5 cognitive modes. Each biases temperature, style, and output pattern.
The operator (or memphis_cognitive_mode_set tool) can switch modes mid-session.

MODE A — ConsciousCapture (temp=0.3):
  Fast, concise, pattern-matching. Use for journal entries, quick retrieval,
  surface-level responses. Low token count.

MODE B — InferredDecisions (temp=0.5) ← CURRENTLY ACTIVE
  Deliberate, evidence-chain reasoning. Use for decisions, architecture choices,
  debugging. Cite evidence from chains when available.

MODE C — PredictivePatterns (temp=0.7):
  Reflective, analogical, predictive. Use for forecasting, "what-if" analysis,
  pattern extrapolation. Higher creativity.

MODE D — CollectiveCoordination (temp=0.4):
  Collaborative, socratic. Use for multi-agent coordination, federation
  discussions, consensus-building. Ask clarifying questions.

MODE E — MetaCognitiveReflection (temp=0.2):
  Meta, concise, self-reflective. Use for daily/weekly reflection cycles,
  self-assessment, alignment checks. Minimize output length.

SWITCHING:
- operator-initiated: memphis_cognitive_mode_set (tier-2, requires passphrase)
- auto-triggered: reflection loop switches to Mode E on schedule
- Current mode read once per turn from soul manifest; no mid-turn switching
</cognitive_modes>
```

**Files:** `src/gateway/system-prompt.ts` plus read `src/cognitive/modes.ts` for authoritative mode definitions (avoid drift). New test.

**Ship criterion.** LLM asked "I need to make an architectural decision — what mode should I be in?" responds "Mode B, because evidence-chain reasoning fits decisions. If you want to run `memphis_cognitive_mode_set --mode B` I can help."

---

## Sprint 0.5 schedule (2 weeks)

| Week | Day | PR | Estimate |
|------|-----|-----|----------|
| 1 | Mon-Tue | **G3** Fix hardcoded path (warmup) | 0.5 day |
| 1 | Tue-Thu | **G1** Auto-gen tool docs | 2-3 days |
| 1 | Fri | **G6** Cognitive modes block | 1 day |
| 2 | Mon-Tue | **G2** Chain catalog refactor | 1-2 days |
| 2 | Wed-Thu | **G4** Safety invariants block | 2-3 days |
| 2 | Fri | **G5** Skills API block | 1-2 days |

Each PR: quality-gate → merge → main CI green → next (same workflow as yesterday's 8 PRs).

## Testing strategy

- **Unit tests** per PR: `tests/unit/system-prompt.<gap>.test.ts`. Each asserts expected fragments/tags/content present in `buildSystemPrompt()` output given controlled input.
- **Snapshot test** for full prompt: `tests/unit/system-prompt.snapshot.test.ts`. Captures golden for full prompt with all 37 tools enabled; changes reviewed per PR.
- **No LLM-in-test.** We don't run actual Claude/Ollama in unit tests. Correctness = "correct text fragments present", not "LLM answers correctly with this prompt".
- **Manual validation** at end of Sprint 0.5: operator runs `memphis chat` with real Anthropic, tests 10 Memphis-structure questions, records which are answered correctly. Baseline for Phase A eval set.

## Sprint 0.5 ship criterion

At end of Sprint 0.5 (post PR #G6 merge):

1. `buildSystemPrompt({ availableTools: <all 37> })` output contains `<tool name="memphis_X">` block for all 37 tool names.
2. `getChainNames()` returns 9 chains matching `ls ~/.memphis/chains/`; single source of truth.
3. Zero `grep "memphis_ai_brain_on_chain" src/` matches.
4. `<safety_invariants>` block present, lists chain integrity + append-lock + offline gate + paranoid tier + circuit breaker + vault boundary + self-modify guards.
5. `<skills_api>` block present with current skill manifest shape.
6. `<cognitive_modes>` block present with all 5 modes; current mode highlighted.
7. Manual eval: 10 Memphis-structure questions → primary LLM answers ≥8/10 correctly.

## How this feeds Phase A training corpus

Post-Sprint 0.5, auto-extract training corpus directly from `buildSystemPrompt()`:

- **Tool Q/A**: for each of 37 tools → generate "how do I use memphis_X?" / "when NOT to use memphis_X?" pairs from docs → ~74 pairs
- **Chain Q/A**: for each of 9 chains → "what lives in chain X?" / "which tools write to chain X?" pairs → ~18 pairs
- **Safety Q/A**: for each of 7 safety invariants → "why is X restricted?" / "what's the safe path for X?" pairs → ~14 pairs
- **Skills Q/A**: manifest shape, entry module shape, when to propose → ~10 pairs
- **Mode Q/A**: for each of 5 modes → "when to use mode X?" / "how to switch to mode X?" pairs → ~10 pairs

**Seed corpus: ~126 auto-extracted high-quality pairs** for Phase A Sprint 2. Rest (target 3000-5000 total) expands via Anthropic-synthesis + operator real-use curation.

This eliminates the risk of "synthetic corpus doesn't match production reality" — the corpus IS production reality (the same prompt that ran in ops).

## Open decision points (discuss before Sprint 0.5 kickoff)

1. **Prompt length budget.** Current ~14KB → post-Sprint 0.5 estimated ~24-30KB. Anthropic prompt caching (ephemeral, 5min TTL) covers repeated calls — but every new conversation pays full cost. Should we:
   - Ship full prompt always (simple, costs more)
   - Dynamically trim based on query (smart, complexity)
   - Split into base + detailed and only include detailed for code/structure queries

2. **Chain list vs `proactive` chain.** Code refers to `proactive`, disk has `insights`. Is one deprecated? Need to decide in PR #G2 week 2 — canonical name + migration path for operators with old state.

3. **Hand-authored vs auto-gen tool docs.** Current 15 tool docs are richer than auto-gen would be (CHAIN EFFECT + SEARCH STRATEGY). Auto-gen 22 missing ones, or promote 5-10 to hand-authored quality first?

My recommendation for each:
1. Ship full prompt + prompt-caching optimizations; monitor token cost for 2 weeks, optimize if problematic.
2. `insights` is canonical (disk reality), deprecate `proactive` in code references — scan for `proactive` usages and correct.
3. Auto-gen all 22 first (working), then hand-enhance on as-used basis (iterative quality improvement). Don't block Sprint 0.5 on manual authoring.

## After Sprint 0.5

Continue as planned in `watra-pretrain-sprint-plan.md`:
- Sprint 1 (Phase A): architecture decisions for WatraLLM pre-training
- Sprint 2: training corpus v1 — now with ~126 high-quality auto-extracted seeds
- Sprint 3-6: training + integration
- Phase B onwards: nightly Watrowanie

Sprint 0.5 doesn't replace any of Phase A-E. It makes each subsequent phase start from a better baseline.
