# 📊 MEMPHIS-V5 PUBLISHING ASSESSMENT — 2026-03-11

**Time:** 07:56 CET
**Purpose:** Verify what we have + GitHub requirements before publishing
**Goal:** Legitimate publishing, no rejections

---

## 🔍 CO MAMY (Current State)

### Repositories

**Memphis-Chains organization (3 repos):**

1. ✅ `Memphis-Chains/memphis` — Cognitive layer (LATEST)
2. ✅ `Memphis-Chains/memphis-v4` — Production core
3. ✅ `Memphis-Chains/memphis` — Legacy fork

### Packages

**Main package:**

- **Name:** `@memphis-chains/memphis-v5`
- **Version:** `0.1.0`
- **Description:** "Memphis Cognitive Engine v5 — OpenClaw's Memory Layer"
- **Files:** dist/, bin/, scripts/, README, LICENSE, docs
- **Bin:** `memphis-v4` (legacy name — needs update)

**Plugin package:**

- **Name:** `@memphis/openclaw-plugin`
- **Version:** `0.1.0`
- **Location:** `packages/@memphis/openclaw-plugin/`
- **Status:** Scaffold only (not built, not tested)

### Code Metrics

- ✅ **25 cognitive modules** (Models A-E)
- ✅ **104 test files**
- ❌ **Build FAILING** (9 TypeScript errors)
- ❌ **Plugin not built**

---

## ⚠️ PROBLEMY DO ROZWIĄZANIA (Before Publishing)

### 🔴 CRITICAL (Must Fix)

#### 1. TypeScript Build Errors (9 errors)

**Files affected:**

- `src/cognitive/model-c.ts` (5 errors)
- `src/cognitive/model-e.ts` (3 errors)
- `src/cli/commands/insight.ts` (2 errors)

**Error types:**

- `error TS2307`: Cannot find module
- `error TS2305`: Module has no exported member
- `error TS18048`: Possibly undefined
- `error TS2769`: No overload matches
- `error TS2322`: Type mismatch

**Impact:** Cannot publish to npm without clean build

**Fix time:** 30-60 min (manual fixes or Codex agent)

---

#### 2. Binary Name Mismatch

**Problem:**

- Package name: `@memphis-chains/memphis-v5`
- Binary name: `memphis-v4` (outdated)

**Fix:**

```json
// package.json
{
  "bin": {
    "memphis": "bin/memphis.js", // NEW
    "memphis-v5": "bin/memphis-v5.js" // ALIAS
  }
}
```

**Impact:** User confusion, wrong binary name

**Fix time:** 5 min

---

#### 3. Plugin Package Not Ready

**Problem:**

- Plugin scaffold exists but:
  - Not built (`dist/` missing)
  - Not tested
  - Not verified with OpenClaw

**Impact:** Cannot publish plugin separately

**Fix time:** 1-2h (build + test)

---

### 🟡 MEDIUM (Should Fix)

#### 4. Scope Inconsistency

**Problem:**

- Main package: `@memphis-chains/memphis-v5`
- Plugin package: `@memphis/openclaw-plugin`

**Two different scopes!**

**Options:**
A) **Standardize on @memphis-chains:**

```json
{
  "name": "@memphis-chains/openclaw-plugin"
}
```

B) **Standardize on @memphis:**

```json
{
  "name": "@memphis/memphis-v5"
}
```

C) **Keep both** (confusing for users)

**Impact:** Branding consistency, npm namespace

**Decision needed:** Which scope to use?

---

#### 5. Account Structure

**User mentioned:**

> "moge sprobowac zmergowac konta memphis-chains/elathoxu-crypto"

**Current state:**

- Organization: `Memphis-Chains`
- User account: `elathoxu-crypto`

**Question:**

- Merge accounts? (transfer repos to personal account?)
- Keep separate? (org = production, personal = experiments?)

**Impact:** Ownership, permissions, billing

**Decision needed:** Merge or keep separate?

---

## 📋 GITHUB PACKAGES REQUIREMENTS

### Authentication

- ✅ **Requires:** Personal Access Token (classic)
- ✅ **Scopes needed:**
  - `write:packages` (publish)
  - `read:packages` (install)
  - `repo` (if private repos)

### Publishing

**Option 1: GitHub Packages (npm.pkg.github.com)**

- ✅ Pros: Free, integrated with GitHub
- ❌ Cons: Requires GitHub account to install
- Best for: Private packages, GitHub-centric teams

**Option 2: Public npm (registry.npmjs.org)**

- ✅ Pros: Public, anyone can install
- ❌ Cons: Requires scope ownership
- Best for: Open source, public packages

### Scope Ownership

**For @memphis-chains scope:**

- ✅ You own the org (Memphis-Chains)
- ✅ Can publish @memphis-chains/\* packages

**For @memphis scope:**

- ❓ Need to verify ownership
- ❓ May conflict with existing @memphis packages

---

## 🎯 PUBLISHING PATHS

### Path A: GitHub Packages (Private/Internal)

```bash
# Configure
npm config set registry https://npm.pkg.github.com
npm login --scope=@memphis-chains --registry=https://npm.pkg.github.com

# Publish
npm publish

# Install
npm install @memphis-chains/memphis-v5 --registry=https://npm.pkg.github.com
```

**Pros:**

- ✅ No scope conflicts
- ✅ Integrated with GitHub
- ✅ Free for public repos

**Cons:**

- ❌ Requires GitHub account
- ❌ Less discoverable

---

### Path B: Public npm (Recommended for OSS)

```bash
# Configure
npm login
# Username: <your-username>
# Password: <your-password>

# Publish
npm publish --access public

# Install
npm install @memphis-chains/memphis-v5
```

**Pros:**

- ✅ Public, discoverable
- ✅ No GitHub account needed
- ✅ Standard npm workflow

**Cons:**

- ⚠️ Scope ownership verification
- ⚠️ Public visibility

---

### Path C: Hybrid (v5 public, plugin GitHub)

```bash
# v5 → public npm
npm publish --access public

# Plugin → GitHub Packages
cd packages/@memphis/openclaw-plugin
npm publish --registry=https://npm.pkg.github.com
```

**Pros:**

- ✅ Best of both worlds
- ✅ v5 widely available
- ✅ Plugin for OpenClaw users

**Cons:**

- ⚠️ Two registries to manage

---

## ✅ PRE-PUBLISH CHECKLIST

### Must Have (Critical)

- [ ] **Fix TypeScript errors** (9 errors blocking build)
- [ ] **Update binary name** (memphis-v4 → memphis-v5)
- [ ] **Build succeeds** (`npm run build` exits 0)
- [ ] **Tests pass** (`npm test` exits 0)
- [ ] **Choose scope** (@memphis-chains vs @memphis)
- [ ] **Choose registry** (public npm vs GitHub Packages)

### Should Have (Important)

- [ ] **Update README** (v5 features, install instructions)
- [ ] **Add CHANGELOG.md** (v0.1.0 release notes)
- [ ] **Verify plugin** (build + basic test)
- [ ] **Update package.json** (keywords, homepage, bugs)

### Nice to Have (Polish)

- [ ] **Add examples/** (usage examples)
- [ ] **Add CONTRIBUTING.md** (how to contribute)
- [ ] **Add CODE_OF_CONDUCT.md** (community standards)
- [ ] **Add LICENSE** (MIT or chosen license)

---

## 📊 TIME ESTIMATES

### Minimal Viable Publish (1-2h)

1. Fix TypeScript errors (30-60 min)
2. Update binary name (5 min)
3. Build + test (10 min)
4. Publish to GitHub Packages (10 min)

### Production-Ready Publish (3-4h)

1. Fix TypeScript errors (30-60 min)
2. Update binary + package.json (15 min)
3. Build + test + verify (20 min)
4. Update README + docs (30-60 min)
5. Publish to public npm (15 min)
6. Create GitHub release (15 min)

### Full Package (1-2 days)

1. All above
2. Verify plugin with OpenClaw (1-2h)
3. Write comprehensive docs (2-3h)
4. Add examples + samples (1-2h)
5. Announce + promote (1-2h)

---

## 🤔 DECYZJE POTRZEBNE OD USERA

### 1. Scope Choice

**Question:** Which npm scope to use?

- [ ] **@memphis-chains** (org, recommended)
- [ ] **@memphis** (shorter, may conflict)
- [ ] **Other:** ****\_****

### 2. Registry Choice

**Question:** Where to publish?

- [ ] **Public npm** (registry.npmjs.org) — recommended for OSS
- [ ] **GitHub Packages** (npm.pkg.github.com) — private/internal
- [ ] **Both** (hybrid)

### 3. Account Structure

**Question:** Merge accounts or keep separate?

- [ ] **Merge:** Transfer Memphis-Chains repos to elathoxu-crypto
- [ ] **Keep separate:** Org = production, personal = experiments
- [ ] **Not sure yet**

### 4. Publishing Timeline

**Question:** When to publish?

- [ ] **Now** (after fixing critical issues, 1-2h)
- [ ] **Later today** (after comprehensive testing, 3-4h)
- [ ] **Tomorrow/This week** (full package with docs)
- [ ] **Wait for feedback** (test with OpenClaw first)

### 5. Plugin Strategy

**Question:** Include plugin in v5 package or separate?

- [ ] **Include** (monorepo, one package)
- [ ] **Separate** (two npm packages)
- [ ] **Skip for now** (publish v5 only)

---

## 🎯 MOJA REKOMENDACJA

### Phase 1: Fix & Publish v5 (2h)

1. ✅ Fix TypeScript errors (Codex agent, 30-60 min)
2. ✅ Update binary name (5 min)
3. ✅ Build + test (10 min)
4. ✅ Publish to **GitHub Packages** (safe first step, 10 min)
5. ✅ Verify install works (10 min)

### Phase 2: Public Release (1h)

1. ✅ Update README + docs (30 min)
2. ✅ Publish to **public npm** (15 min)
3. ✅ Create GitHub release v0.1.0 (15 min)

### Phase 3: Plugin (Later)

1. ✅ Test plugin with OpenClaw (1-2h)
2. ✅ Publish plugin separately (30 min)
3. ✅ Update docs (30 min)

---

## 📝 NEXT ACTIONS

**Immediate (Your decision needed):**

1. Choose scope (@memphis-chains vs @memphis)
2. Choose registry (GitHub Packages vs public npm)
3. Choose timeline (now vs later)
4. Account structure (merge vs keep separate)

**After decisions:**

1. Fix TypeScript errors
2. Update package.json
3. Build + test
4. Publish

---

## 🔗 RESOURCES

- **GitHub Packages docs:** https://docs.github.com/en/packages
- **npm scope docs:** https://docs.npmjs.com/cli/v8/using-npm/scope
- **TypeScript errors:** https://www.typescriptlang.org/docs/handbook/
- **OpenClaw docs:** https://docs.openclaw.ai

---

**Created:** 2026-03-11 07:56 CET
**Status:** Awaiting user decisions
**Next:** User chooses scope + registry + timeline

---

## 💡 TL;DR

**What we have:**

- ✅ v5 repo with 25 cognitive modules
- ✅ 104 test files
- ❌ 9 TypeScript errors (blocking publish)
- ❌ Plugin not ready

**What we need to decide:**

1. Scope: @memphis-chains (recommended) vs @memphis
2. Registry: GitHub Packages (safe) vs public npm (visible)
3. Timeline: Fix + publish now (2h) vs full package (1-2 days)
4. Accounts: Merge vs keep separate

**Recommended path:**

1. Fix TS errors (30-60 min)
2. Publish to GitHub Packages first (safe)
3. Then publish to public npm (visible)
4. Plugin later (after testing)
