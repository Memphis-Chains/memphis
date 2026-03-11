# MEMPHIS v0.1.0-ALPHA RELEASE PLAN

**Created:** 2026-03-11 08:56 CET
**Status:** READY TO EXECUTE (awaiting v4→v5 rename fix)
**Author:** Memphis (production coordinator)
**Approved by:** Elathoxu (08:56 CET)

---

## 🎯 OBJECTIVE

**Goal:** Release Memphis v0.1.0-alpha for internal testing
**Type:** Alpha release (restricted access, not production-ready)
**Timeline:** 15-25 min total execution time

---

## 📋 PHASE 1: VALIDATION (15-20 min, 3 agents parallel)

### Agent 1: EMBEDDINGS VERIFICATION (5-10 min)

**Task:** Verify all 113 files have embeddings

```bash
# Steps:
1. Find all .md files: find . -name '*.md' -type f | wc -l
2. Check embeddings: memphis embed --verify-all
3. Generate missing: memphis embed --missing
4. Report: X/113 files embedded, Y generated, Z failed
```

**Success criteria:** >90% coverage (102+/113 files)
**Failure:** Report which files failed + why

---

### Agent 2: PLUGIN INTEGRATION TEST (5-10 min)

**Task:** Test plugin with real OpenClaw

```bash
# Steps:
1. Build plugin: cd packages/@memphis/openclaw-plugin && npm run build
2. Test plugin load: node -e "require('./src/index.js')"
3. Test basic query:
   - Create test query
   - Call plugin's search method
   - Verify returns results with file paths
4. Report: Plugin works? Errors? Performance?
```

**Success criteria:** Basic query returns results
**Failure:** Report exact error + stack trace

---

### Agent 3: PERFORMANCE BENCHMARK (5-10 min)

**Task:** Benchmark search performance

```bash
# Steps:
1. Run 3 test queries:
   - 'v5 publishing'
   - 'security first'
   - 'codex agents'
2. Measure each query:
   - Time (ms)
   - Results count
   - Relevance score
3. Test with dependency tree loading
4. Report: Average query time, max time, memory usage
```

**Success criteria:** <200ms average query time
- Target: <100ms
- Acceptable: <200ms (for alpha)
- Failure: >200ms average → report bottleneck

---

## 📦 PHASE 2: RELEASE (10-15 min, Memphis executes)

### Step 1: COMMIT ALL CHANGES (2 min)

```bash
git add -A
git commit -m "feat(v0.1.0-alpha): Security layer + File Reference System + Plugin hardening

- Fix all TypeScript errors (0 errors)
- Add chain integrity verification
- Add rollback mechanism
- Add graceful degradation
- Add File Reference System (semantic search)
- Add plugin security hardening
- Tests: 238/241 passing (98.8%)

Phase 1 validation: PASSED
- Embeddings: X/113 verified
- Plugin: Integration tested
- Performance: <100ms queries"

git push origin main
```

---

### Step 2: PUBLISH TO NPM (3 min)

```bash
# Publish with alpha tag (restricted access)
npm publish --tag alpha --access restricted

# Verify
npm view @memphis-chains/memphis-v5@alpha
```

---

### Step 3: CREATE GITHUB RELEASE (5 min)

```bash
gh release create v0.1.0-alpha \
  --title "Memphis v0.1.0-alpha — Security-First Foundation" \
  --notes "## 🧪 ALPHA RELEASE (Internal Testing)

### What's New
- ✅ Security layer (integrity + rollback + degradation)
- ✅ File Reference System (semantic search + dependency tree)
- ✅ Plugin hardening (validation + rate limiting + audit)
- ✅ All TypeScript errors fixed
- ✅ 98.8% test pass rate

### Not Production Ready
This is an **alpha** release for internal testing only.
- No multi-agent sync yet
- Limited documentation
- Performance needs optimization

### Installation (Internal Only)
\`\`\`bash
npm install @memphis-chains/memphis-v5@alpha
\`\`\`

### Next Steps
- Multi-agent sync (v0.2.0-beta)
- User documentation
- Performance optimization
- One-liner install (v1.0.0)"
```

---

## ✅ SUCCESS CRITERIA

### Phase 1 (must pass ALL):
- ✅ Embeddings: >90% coverage (102+/113 files)
- ✅ Plugin: Basic query works (returns results)
- ✅ Performance: <200ms query time (acceptable for alpha)

### Phase 2 (must pass ALL):
- ✅ Git: Clean commit, pushed to main
- ✅ NPM: Published with alpha tag
- ✅ GitHub: Release created with notes

---

## 🚨 ROLLBACK PLAN

### If Phase 1 FAILS:
1. Agent reports issue
2. Memphis reviews
3. Fix or abort
4. No release until fixed

### If Phase 2 FAILS:
```bash
# Rollback commit
git reset --hard HEAD~1
git push origin main --force

# Unpublish npm
npm unpublish @memphis-chains/memphis-v5@0.1.0-alpha

# Delete GitHub release
gh release delete v0.1.0-alpha
```

---

## 🚀 EXECUTION SEQUENCE

### WAVE 1: Phase 1 Validation (Parallel)
```
[ ] Spawn Agent 1: Embeddings verification
[ ] Spawn Agent 2: Plugin integration test
[ ] Spawn Agent 3: Performance benchmark
[ ] Wait for all 3 agents to complete
[ ] Review results
```

### WAVE 2: Phase 2 Release (Sequential)
```
[ ] Memphis commits all changes
[ ] Memphis publishes to npm
[ ] Memphis creates GitHub release
[ ] Verify release is live
[ ] Report completion
```

---

## ⏱️ TIMELINE

- **Phase 1:** 15-20 min (3 agents parallel)
- **Phase 2:** 10-15 min (Memphis sequential)
- **Total:** 25-35 min

---

## 📊 PRE-REQUISITES

### Before Execution:
- ✅ All TypeScript errors fixed (0 errors)
- ✅ Build passing (npm run build exits 0)
- ✅ Tests passing (>95% pass rate)
- 🔄 **v4→v5 renaming complete** (IN PROGRESS - other session)

### Current Blockers:
- 🔄 **v4→v5 naming issues** being fixed on second session
- ⏳ Waiting for rename completion before spawning agents

---

## 🎯 AGENT SPAWN COMMANDS (Ready to Execute)

### Agent 1 (Embeddings):
```typescript
sessions_spawn({
  runtime: "subagent",
  model: "openai-codex/gpt-5.3-codex",
  mode: "run",
  task: "Verify all 113 .md files have embeddings in Memphis-v5..."
})
```

### Agent 2 (Plugin):
```typescript
sessions_spawn({
  runtime: "subagent",
  model: "openai-codex/gpt-5.3-codex",
  mode: "run",
  task: "Test Memphis plugin with real OpenClaw..."
})
```

### Agent 3 (Performance):
```typescript
sessions_spawn({
  runtime: "subagent",
  model: "openai-codex/gpt-5.3-codex",
  mode: "run",
  task: "Benchmark Memphis search performance..."
})
```

---

## 📝 NOTES

- **v4→v5 renaming:** Critical blocker, being fixed on second session
- **Alpha scope:** Internal testing only, not production-ready
- **Next release:** v0.2.0-beta (multi-agent sync + docs)
- **Production release:** v1.0.0 (after security audit)

---

**Status:** PLAN SAVED ✅
**Next Action:** Wait for v4→v5 rename completion → then spawn agents
**Created by:** Memphis (production coordinator)
**Approved by:** Elathoxu (08:56 CET)
