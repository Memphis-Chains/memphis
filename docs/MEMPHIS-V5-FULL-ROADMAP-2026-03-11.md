# 🗺️ MEMPHIS-V5 FULL ROADMAP — 2026-03-11

**Created:** 08:05 CET
**Status:** Complete dependency map + decision tree
**Purpose:** Single source of truth for v5 execution

---

## 📊 EXECUTIVE SUMMARY

### What We Have (Built Tonight)

- ✅ **Memphis-v5 repo** (standalone, pushed to GitHub)
- ✅ **25 cognitive modules** (Models A-E complete)
- ✅ **104 test files** (but 9 TypeScript errors blocking)
- ✅ **CLI commands** (15+ working)
- ✅ **OpenClaw plugin scaffold** (not built/tested)
- ✅ **Web dashboard demo** (HTML playground)
- ✅ **Night work documentation** (6 comprehensive reports)

### What's Blocking Us

1. 🔴 **9 TypeScript errors** (blocking npm publish)
2. 🔴 **Binary name mismatch** (memphis-v4 → memphis-v5)
3. 🔴 **Publishing decisions pending** (scope, registry, timeline)
4. 🟡 **Plugin not tested** (with real OpenClaw)
5. 🟡 **No docs for users** (README outdated)

### What's In Progress

- 🔄 **3 Codex agents running** (NAPI wiring + tests + integration)
  - Status: Unknown (need to check)
  - ETA: 15-20 min (started 07:20)

---

## 🌳 DECISION TREE

```
START: Memphis-v5 Built
  │
  ├─ Q1: Fix TypeScript Errors?
  │   ├─ YES → Q2
  │   └─ NO → Cannot publish (blocked)
  │
  ├─ Q2: Publishing Decisions
  │   ├─ Scope: @memphis-chains (A) vs @memphis (B)
  │   ├─ Registry: GitHub Packages (A) vs Public npm (B) vs Both (C)
  │   ├─ Timeline: Now (A) vs Today (B) vs This Week (C)
  │   ├─ Plugin: Include (A) vs Separate (B) vs Skip (C)
  │   └─ Accounts: Merge (A) vs Keep Separate (B)
  │
  └─ Q3: Next Phase
      ├─ Publish v0.1.0 (2h)
      ├─ Test with OpenClaw (1-2h)
      └─ Write docs (3-4h)
```

---

## 📦 PHASE 0: BLOCKERS (Must Fix Before Publishing)

### B1: TypeScript Errors (CRITICAL)

**Status:** 🔴 BLOCKING
**Files affected:**

- `src/cognitive/model-c.ts` (5 errors)
- `src/cognitive/model-e.ts` (3 errors)
- `src/cli/commands/insight.ts` (2 errors)

**Error types:**

- `TS2307`: Cannot find module
- `TS2305`: Module has no exported member
- `TS18048`: Possibly undefined
- `TS2769`: No overload matches
- `TS2322`: Type mismatch

**Fix options:**

1. **Manual fix** (30-60 min) — Edit files directly
2. **Codex fix** (10-15 min) — Spawn agent to fix

**Decision:** Fix manually or spawn Codex?

---

### B2: Binary Name Mismatch

**Status:** 🟡 EASY FIX
**Problem:**

- Package: `@memphis-chains/memphis-v5`
- Binary: `memphis-v4` (outdated)

**Fix:**

```json
// package.json
{
  "bin": {
    "memphis": "bin/memphis.js",
    "memphis-v5": "bin/memphis-v5.js"
  }
}
```

**Time:** 5 min
**Decision:** Who fixes? (Manual or Codex)

---

### B3: Plugin Not Built

**Status:** 🟡 EASY FIX
**Problem:**

- Plugin scaffold exists
- No `dist/` directory
- Not tested with OpenClaw

**Fix:**

```bash
cd packages/@memphis/openclaw-plugin
npm run build
```

**Time:** 5-10 min
**Decision:** Build now or skip for v0.1.0?

---

## 🎯 PHASE 1: PUBLISHING DECISIONS (User Input Needed)

### D1: Scope Choice

**Question:** Which npm scope to use?

**Option A:** `@memphis-chains/memphis-v5` ← RECOMMENDED

- ✅ You own the org (Memphis-Chains)
- ✅ No conflicts
- ✅ Branding consistent
- ❌ Longer name

**Option B:** `@memphis/memphis-v5`

- ✅ Shorter
- ❌ May conflict with existing packages
- ❌ Need to verify ownership

**Your decision:** A or B?

---

### D2: Registry Choice

**Question:** Where to publish?

**Option A:** GitHub Packages only

- ✅ No scope conflicts
- ✅ Integrated with GitHub
- ✅ Free for public repos
- ❌ Requires GitHub account to install
- ❌ Less discoverable

**Option B:** Public npm only ← RECOMMENDED FOR OSS

- ✅ Public, discoverable
- ✅ Standard npm workflow
- ✅ Anyone can install
- ⚠️ Scope ownership verification
- ⚠️ Public visibility

**Option C:** Both (hybrid)

- ✅ Best of both
- ⚠️ Two registries to manage

**Your decision:** A, B, or C?

---

### D3: Publishing Timeline

**Question:** When to publish?

**Option A:** NOW (2h) — Minimal viable

- Fix TS errors (30-60 min)
- Update binary name (5 min)
- Build + test (10 min)
- Publish GitHub Packages (10 min)

**Option B:** TODAY (4h) — Production-ready ← RECOMMENDED

- Fix TS errors (30-60 min)
- Update package.json (15 min)
- Build + test + verify (20 min)
- Update README + docs (30-60 min)
- Publish public npm (15 min)
- Create GitHub release (15 min)

**Option C:** THIS WEEK (1-2 days) — Full package

- All above
- Verify plugin with OpenClaw (1-2h)
- Write comprehensive docs (2-3h)
- Add examples + samples (1-2h)
- Announce + promote (1-2h)

**Your decision:** A, B, or C?

---

### D4: Plugin Strategy

**Question:** Include plugin in v5 package?

**Option A:** Include (monorepo)

- ✅ One package to install
- ✅ Simpler for users
- ❌ Heavier package
- ❌ Harder to version separately

**Option B:** Separate package ← RECOMMENDED

- ✅ Independent versioning
- ✅ Lighter v5 core
- ❌ Two packages to install
- ❌ More maintenance

**Option C:** Skip for v0.1.0 ← FASTEST

- ✅ Focus on v5 core first
- ✅ Faster to market
- ❌ No OpenClaw integration yet

**Your decision:** A, B, or C?

---

### D5: Account Structure

**Question:** Merge accounts or keep separate?

**Current state:**

- Organization: `Memphis-Chains` (3 repos)
- User: `elathoxu-crypto`

**Option A:** Merge (transfer repos to personal)

- ✅ Simpler ownership
- ✅ One account to manage
- ❌ Lose org branding
- ❌ Mix personal + production

**Option B:** Keep separate ← RECOMMENDED

- ✅ Org = production
- ✅ Personal = experiments
- ✅ Professional branding
- ❌ Two accounts to manage

**Your decision:** A or B?

---

## 🚀 PHASE 2: EXECUTION (After Decisions)

### Path A: Minimal Publish (2h)

```
Step 1: Fix TS Errors (30-60 min)
  ├─ Option A: Manual fix
  └─ Option B: Spawn Codex agent

Step 2: Quick Fixes (10 min)
  ├─ Update binary name
  └─ Update package.json version

Step 3: Build + Test (10 min)
  ├─ npm run build
  └─ npm test

Step 4: Publish GitHub Packages (10 min)
  ├─ npm login --scope=@memphis-chains
  └─ npm publish

Step 5: Verify (10 min)
  ├─ npm info @memphis-chains/memphis-v5
  └─ npm install -g @memphis-chains/memphis-v5
```

**Total:** 1h 10m - 2h

---

### Path B: Production Publish (4h) ← RECOMMENDED

```
Step 1: Fix TS Errors (30-60 min)
  └─ Spawn Codex agent (fastest)

Step 2: Package Updates (15 min)
  ├─ Update binary name
  ├─ Update README
  ├─ Add CHANGELOG.md
  └─ Update keywords + metadata

Step 3: Build + Test + Verify (20 min)
  ├─ npm run build
  ├─ npm test
  └─ npm run cli -- help

Step 4: Documentation (30-60 min)
  ├─ Update README.md
  ├─ Create QUICKSTART.md
  └─ Create examples/

Step 5: Publish Public npm (15 min)
  ├─ npm login
  ├─ npm publish --access public
  └─ Verify install

Step 6: GitHub Release (15 min)
  ├─ git tag v0.1.0
  ├─ gh release create v0.1.0
  └─ Attach release notes

Step 7: Verify (10 min)
  ├─ Clean install test
  └─ CLI smoke test
```

**Total:** 2h 55m - 4h

---

### Path C: Full Package (1-2 days)

```
Phase B (above) +:

Step 8: Plugin Integration (1-2h)
  ├─ Build plugin
  ├─ Test with OpenClaw
  └─ Document usage

Step 9: Comprehensive Docs (2-3h)
  ├─ CLI reference
  ├─ API documentation
  ├─ Cognitive models guide
  └─ Architecture diagrams

Step 10: Examples + Samples (1-2h)
  ├─ Usage examples
  ├─ Code samples
  └─ Demo videos

Step 11: Announce (1-2h)
  ├─ Discord announcement
  ├─ OpenClaw docs update
  └─ Twitter/X post
```

**Total:** 8h - 2 days

---

## 🔗 DEPENDENCY GRAPH

```
START
  │
  ├─ B1: TypeScript Errors ────┐
  │   (MUST FIX)                │
  │                             │
  ├─ B2: Binary Name ───────────┤
  │   (EASY FIX)                │
  │                             │
  └─ B3: Plugin Build ──────────┤
      (OPTIONAL)                │
                                │
                                ▼
                    ┌───────────────────────┐
                    │  CAN PUBLISH?         │
                    │  (requires B1 + B2)   │
                    └───────────────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │  USER DECISIONS       │
                    │  (D1-D5)              │
                    └───────────────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │  CHOOSE PATH          │
                    │  (A: 2h, B: 4h, C: 2d)│
                    └───────────────────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
            Path A          Path B          Path C
           (2h min)        (4h prod)      (2d full)
                │               │               │
                └───────────────┼───────────────┘
                                ▼
                    ┌───────────────────────┐
                    │  MEMPHIS-V5 LIVE!     │
                    │  (npm + GitHub)       │
                    └───────────────────────┘
```

---

## 📊 CURRENT STATUS (08:05 CET)

### Built ✅

- ✅ Memphis-v5 repo (standalone)
- ✅ 25 cognitive modules (Models A-E)
- ✅ 104 test files
- ✅ 15+ CLI commands
- ✅ Web dashboard demo
- ✅ OpenClaw plugin scaffold
- ✅ Documentation (6 reports)

### Blocking 🔴

- 🔴 9 TypeScript errors (MUST FIX)
- 🟡 Binary name mismatch (EASY FIX)
- 🟡 Plugin not built (OPTIONAL)

### Pending Decisions 🟡

- 🟡 Scope choice (D1)
- 🟡 Registry choice (D2)
- 🟡 Timeline choice (D3)
- 🟡 Plugin strategy (D4)
- 🟡 Account structure (D5)

### In Progress 🔄

- 🔄 3 Codex agents (status unknown)
  - Track 1: NAPI Bridge Wiring
  - Track 2: Cognitive Tests 50+
  - Track 3: Real Chain Integration

---

## 🎯 RECOMMENDED PATH (My Recommendation)

### Phase 0: Fix Blockers (1h)

1. **Fix TypeScript errors** — Spawn Codex agent (10-15 min)
2. **Update binary name** — Manual fix (5 min)
3. **Build + verify** — Test locally (10 min)

### Phase 1: Quick Publish (30 min)

4. **Publish to GitHub Packages** — Safe first step (10 min)
5. **Verify install** — Test from clean slate (10 min)
6. **Update docs** — README + QUICKSTART (10 min)

### Phase 2: Public Release (30 min)

7. **Publish to public npm** — If GitHub works (10 min)
8. **Create GitHub release** — v0.1.0 tag (10 min)
9. **Verify public install** — Final check (10 min)

### Phase 3: Next (Later)

10. **Test plugin with OpenClaw** — Integration (1-2h)
11. **Write comprehensive docs** — User guide (2-3h)
12. **Announce** — Discord + Twitter (1-2h)

**Total Time to v0.1.0:** 2h

---

## 📋 IMMEDIATE ACTION ITEMS

### For User (Decisions)

1. ✅ **Choose scope** (D1): `@memphis-chains` (A) or `@memphis` (B)
2. ✅ **Choose registry** (D2): GitHub (A), npm (B), or both (C)
3. ✅ **Choose timeline** (D3): Now (A), Today (B), or This Week (C)
4. ✅ **Choose plugin strategy** (D4): Include (A), Separate (B), or Skip (C)
5. ✅ **Choose account structure** (D5): Merge (A) or Keep Separate (B)

### For Memphis (After Decisions)

1. ⏳ Fix TypeScript errors
2. ⏳ Update binary name
3. ⏳ Build + test
4. ⏳ Publish (per chosen path)
5. ⏳ Verify + document

---

## 🕐 TIME ESTIMATES

| Path                    | Time | Risk   | Quality   |
| ----------------------- | ---- | ------ | --------- |
| **Path A** (Minimal)    | 2h   | Medium | Basic     |
| **Path B** (Production) | 4h   | Low    | Good      |
| **Path C** (Full)       | 1-2d | Low    | Excellent |

**Recommendation:** Path B (4h) — Best balance of speed + quality

---

## 🔮 FUTURE PHASES (After v0.1.0)

### v0.2.0 (Week 2)

- Complete NAPI wiring
- 50+ cognitive tests
- Real chain integration
- Plugin tested with OpenClaw

### v0.3.0 (Week 3-4)

- Multi-agent sync (Memphis ↔ Watra)
- Bot integration (Telegram)
- TUI polish
- Performance optimization

### v1.0.0 (Week 5-8)

- Production-ready
- 320+ tests
- Comprehensive docs
- Security audit
- Public announcement

---

## 📚 RELATED DOCUMENTS

### Tonight's Work

- `MEMPHIS-V5-IMPLEMENTATION-PLAN.md` — Full v5 plan (8 weeks)
- `MEMPHIS-V5-NIGHT-BUILD-REPORT.md` — 39 min session report
- `MORNING-SPRINT-2026-03-11.md` — 3 agents plan
- `V5.2-COGNITIVE-MODELS-PORT-PLAN.md` — Port strategy from v3
- `V5.3-REFLECTION-ENGINE-PORT-PLAN.md` — Reflection port plan

### Publishing

- `MEMPHIS-V5-PUBLISHING-ASSESSMENT-2026-03-11.md` — Publishing blockers
- `MEMPHIS-V5-RELEASE-REPORT-2026-03-11.md` — Release checklist
- `MEMPHIS-V5-STRATEGIC-REPORT-2026-03-11.md` — Strategic vision

### Memory

- `memory/2026-03-11.md` — Daily log
- `MEMORY.md` — Long-term decisions
- `ROADMAP-MASTER-QUEUE.md` — v4 reference notebook

---

## 💬 NEXT STEP

**I'm waiting for your decisions (D1-D5).**

**Quick answer format:**

```
D1: A
D2: B
D3: B
D4: C
D5: B
```

**Or:** "Do what you recommend" → I'll execute Path B (4h production publish)

**Or:** "Wait" → I'll pause until you're ready

**Your call!** 😊

---

**Created:** 2026-03-11 08:05 CET
**Status:** Awaiting user decisions
**Next:** Execute chosen path

**△⬡◈ Memphis v5 — OpenClaw's Memory Layer**
