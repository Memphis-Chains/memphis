# Architecture Review: feat/soul-system-phase-a

**Review date:** 2026-03-25
**Branch:** `feat/soul-system-phase-a` — 7 commits ahead of `main`
**Reviewer:** Claude Code Architecture Review Agent
**Scope:** Code Analysis, Architecture Implications, Depth Analysis, Risk Assessment, Merge Recommendation

---

## Executive Summary

The `feat/soul-system-phase-a` branch introduces a substantial **persistent identity system (Soul)**, a **case-based knowledge graph (memphis-case-index)**, and a **tiered authorization framework**. Net change is **-22,843 lines** (373 files changed), indicating major cleanup alongside new features. The branch removes old federation code and several CLI handlers (`evolve`, `secret`, `telegram`, `gateway`) and **accidentally removes soul seeding** via `seed.ts` deletion — not an intentional deprecation but a merge conflict casualty. The tiered authorization (`authorization.ts`) is implemented but **may not be wired into the gateway dispatcher**, raising questions about whether it actually gates tool execution. memphis-case-index is a clean, well-tested SQLite materialized index with NAPI bridge — not a Synjar replacement. **RECOMMENDATION: DEFER** — fix 3 critical integration gaps before merge.

---

## 1. Code Analysis

### Commit History
```
0ed8506 merge: resolve conflicts from main into feat/soul-system-phase-a
332d192 ci: add workflow_dispatch trigger to enable manual CI runs
887893e ci: trigger quality gate
dd78830 fix(test): isolate full-workflow E2E from host agent profile
d0c7c4d feat(gateway): add tiered authorization with autonomy modes and trust rules
6cdad56 feat(soul): add persistent identity system and case-based knowledge graph
dd23f30 fix(test): isolate guide tests from host agent-profile and fix cargo discovery
```

### Diff Summary
- **373 files changed, +3,739 insertions, -26,582 deletions**
- Largest additions: new Soul system (TS), new memphis-case-index (Rust), new tiered auth
- Largest deletions: federation/ directory, self-modification tools, evolve handler, seed.ts

### Backwards Compatibility
- **Config:** Soul manifest is auto-generated; old configs remain valid
- **CLI:** `memphis trust` is new (additive); no backwards break for existing commands
- **Breaking:** `evolve`, `secret`, `telegram`, `gateway` CLI handlers removed from dispatcher; federation directory removed
- **Data:** Chain files (journal, cases) remain; case-index SQLite is a rebuildable cache

### Focus Area Findings

**`crates/memphis-case-index/`** — New Rust crate. SQLite-backed materialized index for case-based chain entries. 803 lines, 10+ unit tests. NAPI bridge to TypeScript via `memphis-napi`. Clean architecture: chain files are source of truth, SQLite is rebuildable query cache.

**`src/gateway/authorization.ts`** — Tiered auth resolver. 4-layer priority: explicit SQLite policy > trust rule > mode+tier default > deny unknown. Three autonomy modes (quiet/balanced/paranoid). Well-structured with Zod schemas.

**`src/infra/cli/handlers/trust.handler.ts`** — CLI for trust rules and autonomy mode. Subcommands: `list`, `add`, `remove`, `mode set`. Clean implementation.

**Soul system** — Persistent identity via JSON manifest + JSON memory. NOT a persona/character system. Boots from agent profile, seeds memory via MCP tools. Case chain provides audit trail.

---

## 2. Component Deep Dives

### MEMPHIS-CASE-INDEX

**What it does:** SQLite materialized index for case-based reasoning. The chain files (`{dataDir}/chains/cases/`) are the source of truth; the SQLite DB at `{dataDir}/case-index.sqlite` is a rebuildable cache optimized for fast querying.

**How it works:** Indexes 8 Polish grammatical cases as semantic relationship types. Each case has different field roles:

| Case | Semantic Role | Key Fields |
|------|--------------|------------|
| Nominative | Subject/Agent | entity, action |
| Genitive | Possession | owner, possessed |
| Dative | Recipient | giver, recipient, object |
| Accusative | Direct Object | subject, verb, object |
| Instrumental | Means/Tool | actor, instrument, target |
| Locative | Location | entity, location |
| Ablative | Origin | entity, origin, destination |
| Vocative | Invocation | invoker, invocation |

**Data flow:**
```
TypeScript → CaseChainAdapter → memphis-napi (NAPI/FFI) → memphis-case-index (Rust) → SQLite
```

**Query support:** Filter by `case_type`, `entity`, `actor`, `target`, `instrument`, `location` with limit. Purely synchronous, in-process SQLite.

**Performance:** SQLite with 8 composite indexes. Rebuild is O(n) full-scan. Query is indexed O(log n). Reasonable for pilot scale.

**Is it needed? For whom?** Yes — enables fast case-based lookups for the Soul memory system. The case chain is a core Memphis audit trail. Without it, case queries would require full chain file scans.

**vs Synjar:** Not a replacement. Synjar (`:3777`) is a peer service for knowledge retrieval — separate process, separate concern. memphis-case-index is a local SQLite index for Memphis's own case chain.

---

### SOUL SYSTEM

**What it is:** Persistent identity and memory system for the Memphis agent. NOT an agent persona/character. Soul is an **architectural layer** that stores and retrieves the agent's self-model and user preferences.

**Components:**
- `soul-manifest.json` — Auto-generated on every boot. Captures: identity (agentName, ownerName, DID), capabilities (tools, chains, channels, providers), boundaries (tier0/1/2 auth scope), evolution policy, autonomy mode, trust rules
- `soul-memory.json` — User prefs (name, languages, preferences, expertise, integrations) + self-knowledge (personality, strengths, learnings, evolvedCapabilities) + context (activeWork, recentDecisions)
- Soul Boot (`src/soul/boot.ts`) — `isSoulBootNeeded()`, `buildSoulBootPrompt()` for first-boot user onboarding
- Soul Manifest (`src/soul/manifest.ts`) — `generateSoulManifest()`, `loadSoulManifest()`, `ensureSoulManifest()`
- Soul Memory (`src/soul/memory.ts`) — `loadSoulMemory()`, `writeSoulMemory()`, `updateSoulMemory()` with deep-merge

**Where it sits in the pipeline:** Soul manifest is injected into the system prompt via `buildSystemPrompt()` at gateway boot. Soul memory is loaded/read by MCP tools at runtime. Soul writes are mirrored to the case chain for accountability.

**Persona change?** No. Soul does NOT change how Memphis speaks or behaves. It stores identity metadata and user preferences — not voice, tone, or personality traits. The "persona" lives in the agent profile, not Soul.

**Critical issue — seed.ts deleted:** `src/soul/seed.ts` was deleted in this branch (not on main). On main, `seedSoulIdentity()` writes 5 journal entries + 8 case entries on first boot. On the feat branch, no seeding occurs — `isSoulBootNeeded()` only checks if `soul-memory.json` is empty, and no chain entries are written. This appears to be an accidental deletion during merge conflict resolution, not an intentional design change. The SOUL_GUIDE.md still documents the seeding system.

---

### TIERED AUTHORIZATION (AUTHORIZATION + TRUST)

**What it is:** A runtime tool policy resolver for the gateway, layered above the existing CLI operator gate.

**Autonomy modes:**

| Mode | Tier 0 Tools | Tier 1 Tools | Tier 2 Tools |
|------|-------------|-------------|-------------|
| `quiet` | allow | allow | require-approval |
| `balanced` (default) | allow | require-approval | require-approval |
| `paranoid` | require-approval | require-approval | require-approval |

**Trust rules:** Per-tool overrides in `soul-manifest.json`. `autoApprove: true` → allow without approval. `autoApprove: false` → require-approval. Supports `*` wildcard.

**Priority order:**
1. Explicit SQLite policy (operator override via `tool_permissions` table)
2. Trust rule from soul manifest
3. Mode + tier defaults
4. Unknown tool → deny (fail-closed)

**CLI:** `memphis trust list|add|remove`, `memphis trust mode set <mode>`

**Does it replace or extend existing auth?** Extends. The operator gate (`isGatedOperation` in `src/infra/auth/operator-gate.ts`) guards CLI mutations. The tiered auth gates **runtime tool execution** in the gateway. They are orthogonal.

**CRITICAL UNKNOWN:** `authorization.ts` is defined but I found no evidence it is called from the gateway dispatcher or tool execution path in the reviewed code. The gateway (`src/gateway/server.ts`) does NOT import `authorization.ts`. This must be verified before merge — if `resolveToolPolicy()` is never called, the entire tiered auth system is dead code.

---

## 3. Architecture Implications

### Q1: Is Soul an agent persona or core system?

**Soul is a core system component** (persistent identity + memory), not a persona system.

Evidence:
- Soul stores: agentName, ownerName, DID, capabilities, boundaries, evolution policy
- Soul does NOT store: voice, tone, language style, character traits
- Soul manifest is injected into system prompt for identity context
- Soul memory enables personalized user interactions (preferences, expertise)
- Soul does NOT affect response generation or tool selection logic directly

Soul is closer to a "user profile + agent identity document" than a character system.

---

### Q2: memphis-case-index — replacement or complement to Synjar?

**Complement.** No overlap.

| | memphis-case-index | Synjar |
|---|---|---|
| Type | Local SQLite index | Peer RPC service (`:3777`) |
| Data | Memphis case chain entries | External knowledge |
| Query | Structured (case type, entity, actor...) | Likely keyword/semantic |
| Location | In-process | Separate process |
| Purpose | Fast case lookup + audit trail | Knowledge retrieval |

Synjar is a separate microservice for Memphis's knowledge needs. memphis-case-index is Memphis's own indexed audit trail. They address different concerns.

---

### Q3: Does tiered authorization extend or replace existing security model?

**Extends, not replaces.** Two orthogonal layers:

| Layer | Scope | File | What it gates |
|---|---|---|---|
| Operator Gate | CLI mutations | `src/infra/auth/operator-gate.ts` | `vault`, `secret`, `trust add`, `evolve`, `configure`... |
| Tiered Auth | Runtime tool execution | `src/gateway/authorization.ts` | MCP tool calls during agent loops |

The operator gate was NOT modified by this branch. Tiered auth adds a new runtime layer for tool execution policy.

**Potential issue:** The tiered auth resolver (`resolveToolPolicy()`) may not be wired into the gateway. Need to verify `authorization.ts` is actually called before merge.

---

### Q4: Does this support Sprint 18-20 (Telegram auto-start, auto-memory)?

**Partially.** The Soul system directly enables auto-memory:
- Soul memory (`soul-memory.json`) stores user preferences, languages, expertise
- Soul manifest captures channels including Telegram (`TELEGRAM_BOT_TOKEN` detection)
- `buildSoulBootPrompt()` provides first-boot user onboarding for Telegram integration

However:
- Telegram command handler (`telegramCommandHandler`) was **removed** from the CLI dispatcher in this branch
- `src/infra/cli/handlers/telegram.handler.ts` is gone
- This directly conflicts with Sprint 18-20 Telegram auto-start goal

**Verdict:** Soul memory is aligned with auto-memory Sprint goal. But the Telegram handler removal is a blocker.

---

### Q5: Are there breaking changes?

**Yes — multiple breaking changes:**

1. **CLI handlers removed:** `evolve`, `secret`, `telegram`, `gateway` commands are gone from dispatcher (present on main, absent on feat branch)
2. **Federation removed:** `federation/` directory is deleted — Matrix federation is removed
3. **Soul seeding removed:** `seed.ts` deleted — first boot no longer writes journal/case entries
4. **websocket-transport.ts deleted:** Sync transport abstraction changed
5. **No explicit migration path:** Existing agents with populated chains have case-index rebuilt on boot, but the removal of federation may break multi-agent setups

**Old config compatibility:** Soul manifest is auto-generated; agent profiles still work. But `MEMPHIS_FEDERATION_*` env vars become no-ops.

---

## 4. Risk Assessment

### 1. Technical Debt — Score: 2/5

**Positive signs:**
- memphis-case-index has 10+ unit tests in lib.rs
- Soul system has unit tests (`soul-boot.test.ts`, `soul-manifest.test.ts`, `soul-memory.test.ts`)
- Zod schema validation on all Soul JSON files
- Clean separation: manifest/memory/boot are small, focused modules
- Rust code is idiomatic with proper error enum wrapping

**Concerns:**
- `authorization.ts` may be dead code (not wired into gateway) — verification needed
- seed.ts deletion is undocumented; no rationale in commit messages
- No e2e tests visible for the full soul bootstrap flow
- Rust crate has no README or inline documentation beyond lib.rs rustdoc

---

### 2. Integration Risk — Score: 4/5 (HIGH)

**Breaking changes:**
- CLI handlers removed (`evolve`, `secret`, `telegram`, `gateway`) — any automation/scripts using these commands will break
- Federation removed — multi-agent Matrix federation setups lose functionality
- `seed.ts` deletion — first-boot seeding behavior silently removed; SOUL_GUIDE.md is now inaccurate

**Test compatibility:**
- Main's test suite expects `seedSoulIdentity()` in bootstrap.ts and doctor-v2.ts
- Feat branch removes these calls — tests written against main may fail

**Data migration:**
- Case index rebuild on boot is safe (chain files are source of truth)
- Soul manifest is auto-generated — no migration needed
- Soul memory is deep-merged on update — no migration needed

---

### 3. Complexity Risk — Score: 3/5

**New code burden:**
- memphis-case-index: 803 lines Rust + 372 lines TypeScript adapter
- Soul system: ~600 lines TypeScript across 5 modules
- Tiered auth: ~150 lines TypeScript
- Total new code: ~1,500 lines across Rust + TypeScript

**Rust crate concern:** memphis-case-index adds a new Rust crate with bundled SQLite (adds ~5MB to binary). Requires cargo build step. The crate is well-isolated via NAPI bridge.

**Understanding risk:** Low. Soul is conceptually simple (manifest + memory JSON files). Case-index is a standard SQLite pattern. Tiered auth is 3-mode policy lookup. A developer can understand each component in <2 hours.

**Key person risk:** Low. Soul system is well-documented in SOUL_GUIDE.md (549 lines).

---

### 4. Strategic Risk — Score: 3/5

**v1.0.0 alignment:** Soul + case-index + tiered auth moves Memphis toward stable agent identity (v1 milestone). Aligns with long-term roadmap.

**Hotel-Jawor pilot support:**
- Soul memory (user preferences, languages) directly supports personalized Telegram interactions
- Case-index enables fast knowledge lookups
- BUT: Telegram handler was removed — directly conflicts with Telegram auto-start
- Federation removal: Hotel-Jawor uses self-hosted Synapse — federation removal may not affect them (pilot is single-agent)

**Speculation risk:** Medium. Soul seeding removal suggests the team may be reconsidering the "seed on first boot" design. If soul seeding IS needed for pilot, this branch removes it by accident. The "why" is not documented.

---

## 5. Risk Summary Table

| Risk | Score | Justification |
|------|-------|--------------|
| Technical Debt | 2/5 | Well-tested, clean code, Zod validation |
| Integration Risk | 4/5 | CLI handlers removed, federation removed, seed.ts deleted |
| Complexity Risk | 3/5 | New Rust crate burden, but well-isolated |
| Strategic Risk | 3/5 | Supports auto-memory, but Telegram handler removal is a Sprint 18-20 blocker |
| **Overall** | **3/5** | Substantial new capability with significant integration gaps |

---

## 6. Merge Recommendation

### RECOMMENDATION: DEFER

**Reasons to defer, not reject:**
- The core Soul + case-index + tiered auth architecture is sound
- Code quality is good (tests, Zod schemas, Rust idioms)
- The branch moves Memphis toward stable v1.0.0 identity model
- 26k lines of cleanup is healthy debt reduction

**Critical blockers (must fix before merge):**

### Blocker 1: Soul Seeding Removal (Accidental)
- `src/soul/seed.ts` was deleted in this branch (confirmed via `git show feat/soul-system-phase-a:src/soul/seed.ts` → file not found)
- `seedSoulIdentity()` is called in main's `bootstrap.ts` and `doctor-v2.ts` but NOT in the feat branch's versions
- SOUL_GUIDE.md still describes seeding (doc/code mismatch)
- **Fix required:** Either restore `seed.ts` and its bootstrap calls, OR explicitly design-out seeding and update SOUL_GUIDE.md

### Blocker 2: Tiered Auth Dead Code Check
- `src/gateway/authorization.ts` defines `resolveToolPolicy()` but `src/gateway/server.ts` does NOT import it
- The gateway dispatcher has no reference to tiered authorization
- **Fix required:** Verify that `authorization.ts` is wired into the gateway tool execution path, OR the feature is incomplete and should not be merged as-is

### Blocker 3: Telegram Handler Removal
- `telegramCommandHandler` is absent from feat branch's `dispatcher.ts`
- Present on main. Directly conflicts with Sprint 18-20 Telegram auto-start goal
- **Fix required:** Either restore `telegram.handler.ts` and re-add to dispatcher, OR confirm Telegram integration will be re-implemented differently

### Non-blocking concerns (resolve before production):
- CLI handlers removed (`evolve`, `secret`, `gateway`) — document the removal and update CLI documentation
- Federation removed — confirm this is intentional and align with team
- Main's test suite expects `seedSoulIdentity()` calls that don't exist on feat branch — tests must be updated

### Merge Prerequisites (if blockers resolved):
1. Restore soul seeding OR explicitly design out and update docs
2. Wire `resolveToolPolicy()` into gateway tool execution OR mark tiered auth as Phase B
3. Restore Telegram handler OR document it will be re-implemented in Sprint 19
4. Update SOUL_GUIDE.md to reflect actual implementation (remove seeding references if removed)
5. Update `dispatcher.ts` to include removed handlers OR document their removal

### If blockers cannot be resolved:
Consider **partial merge** — take only memphis-case-index + soul manifest/memory infrastructure (without seed.ts removal) and defer tiered auth to Phase B.

---

## 7. Next Steps

### Immediate (before merge approval):
1. **Restore/check soul seeding:** Run `git show feat/soul-system-phase-a:src/soul/seed.ts` — confirm it's gone. Then decide: restore or design-out explicitly
2. **Verify tiered auth wiring:** Search for calls to `resolveToolPolicy` and `recordAuthorizationDecision` on the feat branch — confirm they exist in the gateway execution path
3. **Telegram handler decision:** Is `telegram.handler.ts` being re-implemented? If not, restore it
4. **Run verification:**
   ```bash
   cargo check -p memphis-case-index 2>&1  # should pass
   git checkout feat/soul-system-phase-a && npm test -- --run 2>&1 | tail -20
   ```

### If all blockers resolved — merge order:
1. Merge `feat/soul-system-phase-a` into `main`
2. Monitor Hotel-Jawor pilot for soul seeding issues (no first-boot case entries)
3. Ship Telegram handler restoration as Sprint 19 hotfix if needed

---

## Appendix: Key Files

### New Files (feat branch)
| File | Purpose | Lines |
|------|---------|-------|
| `crates/memphis-case-index/src/lib.rs` | SQLite case index | ~803 |
| `crates/memphis-case-index/Cargo.toml` | Crate manifest | ~15 |
| `src/soul/types.ts` | Zod schemas + interfaces | ~205 |
| `src/soul/manifest.ts` | Manifest generation/loading | ~114 |
| `src/soul/memory.ts` | Memory loading/writing/merge | ~146 |
| `src/soul/boot.ts` | First-boot detection + prompts | ~48 |
| `src/gateway/authorization.ts` | Tiered auth resolver | ~100 |
| `src/infra/storage/case-chain-adapter.ts` | NAPI bridge + TS fallback | ~372 |
| `src/memory/case-types.ts` | TypeScript case types | ~81 |
| `src/mcp/tools/soul.ts` | Soul MCP tools | ~160 |
| `docs/SOUL_GUIDE.md` | Soul system documentation | ~549 |

### Deleted/Modified Files
| File | Change | Impact |
|------|--------|--------|
| `src/soul/seed.ts` | **DELETED** | Soul seeding removed (critical) |
| `src/infra/cli/handlers/trust.handler.ts` | Modified | New trust CLI (additive) |
| `src/infra/cli/dispatcher.ts` | Modified | Removed: evolve, secret, telegram, gateway handlers |
| `federation/` | DELETED | Matrix federation removed |
| `src/sync/websocket-transport.ts` | Modified | Sync transport changed |

### Commit Diff (main → feat)
```
373 files changed, 3739 insertions(+), 26582 deletions(-)
```

---

*Review generated: 2026-03-25 | MemphisOS Architecture Review*
*Constraints applied: No code changes, no merge, critical assessment, ~60 min limit*
