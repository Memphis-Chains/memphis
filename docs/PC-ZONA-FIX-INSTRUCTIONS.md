# PC-ZONA FIX INSTRUCTIONS (10.0.0.25)

**Problem:** TypeScript build errors (9 errors)
**Cause:** Outdated code (2 commits behind)
**Time:** ~3 minutes
**Difficulty:** Easy (copy-paste)

---

## ✅ QUICK FIX (3 commands)

```bash
cd ~/memphis
git pull origin main
npm run build
```

**That's it!** Build should now succeed.

---

## 📋 DETAILED STEPS

### Step 1: Check Status (30 seconds)

```bash
cd ~/memphis
git status
```

**Expected output:**
```
On branch main
Your branch is behind 'origin/main' by 2 commits
```

### Step 2: Fetch Updates (10 seconds)

```bash
git fetch origin
```

**Expected output:**
```
remote: Enumerating objects: XX, done.
remote: Counting objects: 100% (XX/XX), done.
Unpacking objects: 100% (XX/XX), done.
```

### Step 3: Pull Latest Code (20 seconds)

```bash
git pull origin main
```

**Expected output:**
```
Updating abc123..def456
Fast-forward
 src/cli/commands/insight.ts      |  4 +-
 src/cognitive/model-c.ts         | 86 +++++-----
 src/cognitive/model-e.ts         | 72 ++++++---
 src/cognitive/proactive-assistant.ts | 13 +-
 src/security/integrity.ts        | 177 ++++++++++++++++++
 5 files changed, 317 insertions(+), 35 deletions(-)
 create mode 100644 src/security/integrity.ts
```

### Step 4: Rebuild (1-2 minutes)

```bash
npm run build
```

**Expected output:**
```
> @memphis-chains/memphis-v5@0.1.0-alpha.1 build
> npm run build:rust && tsc -p tsconfig.json

    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.07s
```

**NO TypeScript errors!** ✅

### Step 5: Verify (10 seconds)

```bash
memphis health
```

**Expected output:**
```json
{
  "status": "ok",
  "service": "memphis-v5",
  "version": "0.1.0-alpha.1"
}
```

---

## ✅ SUCCESS CRITERIA

- [ ] `git status` shows "up to date"
- [ ] `npm run build` exits 0 (no errors)
- [ ] `memphis health` returns "status: ok"
- [ ] No TypeScript errors

---

## 🔧 TROUBLESHOOTING

### Problem: Merge Conflicts

**Symptom:**
```
CONFLICT (content): Merge conflict in src/...
Automatic merge failed
```

**Fix:**
```bash
# Option A: Keep theirs (use incoming changes)
git checkout --theirs src/path/to/file.ts
git add src/path/to/file.ts
git commit -m "fix: resolve merge conflict"

# Option B: Keep yours (keep local changes)
git checkout --ours src/path/to/file.ts
git add src/path/to/file.ts
git commit -m "fix: resolve merge conflict"
```

### Problem: Missing Commit ecd2884

**Symptom:** Still getting TypeScript errors after pull

**Fix:**
```bash
# Verify you have the fix commit
git log --oneline -5 | grep ecd2884

# If not, fetch and reset
git fetch origin
git reset --hard origin/main
npm run build
```

### Problem: Build Still Failing

**Symptom:**
```
src/cognitive/model-c.ts(206,7): error TS18048: 'block.data' is possibly 'undefined'
```

**Fix:**
```bash
# Clean and rebuild
rm -rf node_modules package-lock.json dist
npm install
npm run build
```

### Problem: memphis Command Not Found

**Symptom:**
```
memphis: command not found
```

**Fix:**
```bash
# Re-link globally
npm link

# Or use directly
./bin/memphis.js health
```

### Problem: Permission Denied

**Symptom:**
```
./bin/memphis.js: Permission denied
```

**Fix:**
```bash
chmod +x bin/memphis.js
```

---

## ⏱️ TIME ESTIMATES

| Step | Time |
|------|------|
| Check status | 30s |
| Fetch updates | 10s |
| Pull code | 20s |
| Rebuild | 1-2 min |
| Verify | 10s |
| **TOTAL** | **~3 min** |

---

## 📊 WHAT'S IN THE FIX

**Commit:** `ecd2884` (2026-03-11 08:23 CET)

**Files changed:** 5
- `src/cli/commands/insight.ts` (4 lines) — Fixed import paths
- `src/cognitive/model-c.ts` (86 lines) — Added DecisionBlock, safe guards
- `src/cognitive/model-e.ts` (72 lines) — Normalized blocks, safe access
- `src/cognitive/proactive-assistant.ts` (13 lines) — Proper types
- `src/security/integrity.ts` (177 lines, NEW) — Chain verification

**Total:** 317 insertions(+), 35 deletions(-)

---

## 🎯 DEFINITION OF DONE

✅ **When complete:**
1. Git status shows "up to date"
2. Build succeeds with 0 errors
3. `memphis health` returns OK
4. All 5 fixed files present

---

## 📝 AFTER FIX

**Next steps:**
1. Test Memphis:
   ```bash
   memphis journal "pc-zona fixed!"
   memphis search "fixed"
   ```

2. Test sync (if configured):
   ```bash
   memphis agents discover
   memphis sync status
   ```

3. Report back to Memphis (10.0.0.80) that fix successful

---

## 🔗 QUICK REFERENCE

**Repository:** https://github.com/Memphis-Chains/memphis-v5
**Fix commit:** ecd2884f00001ec2940e7857283965c437d0e264
**Issue date:** 2026-03-11 08:23 CET
**Fixed by:** Memphis-Chains

---

## 💬 NEED HELP?

If still failing after following these instructions:

1. Copy full error output
2. Run: `git log --oneline -10`
3. Run: `npm run build 2>&1 | head -50`
4. Share with Memphis (10.0.0.80)

---

**Created for:** pc-zona (Wife PC - 10.0.0.25)
**Created by:** Memphis (△⬡◈)
**Date:** 2026-03-11 09:58 CET
**Status:** Ready to use
