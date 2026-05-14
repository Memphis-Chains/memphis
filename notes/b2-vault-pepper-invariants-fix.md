# B2 follow-up micro-PR — vault-pepper-invariants unused eslint-disable

**Status:** Draft, NOT pushed. Ready to apply post-merge of either Coder A's bundled Codex round-N hotfix OR as standalone if no other findings ship in the round.

**Context:** Pre-merge review of #593 (`notes/pr593-pre-merge-review.md`) flagged that `tests/unit/vault-pepper-invariants.test.ts` had 2 unused `eslint-disable-next-line no-restricted-syntax` directives (lines 52, 108), which is what triggered Coder A's `--no-verify` bypass on commit A.5.6. Coder A asked me on #593 to verify + propose a fix.

**Verified on plain main (HEAD `fc7e7da8`):**

```
$ npx eslint tests/unit/vault-pepper-invariants.test.ts
   52:7  warning  Unused eslint-disable directive (no problems were reported from 'no-restricted-syntax')
  108:7  warning  Unused eslint-disable directive (no problems were reported from 'no-restricted-syntax')
✖ 2 problems (0 errors, 2 warnings)
```

Both `eslint-disable` directives sit above `execSync(...)` calls. The `no-restricted-syntax` rule targets direct `process.env.X` reads (per Memphis env-registry convention), not `execSync` — so the directives are unneeded.

## Patch (ready to apply)

```diff
--- a/tests/unit/vault-pepper-invariants.test.ts
+++ b/tests/unit/vault-pepper-invariants.test.ts
@@ -49,7 +49,6 @@ describe('vault pepper invariants', () => {
     // intentionally narrow: we want the helper functions, not every
     // env read.
     const out = execSync(
-      // eslint-disable-next-line no-restricted-syntax
       'grep -rnE ' +
         '"deriveStateEncryptionKey|decrypt_master_key_v2|encrypt_master_key_v2" ' +
         '--include="*.ts" --include="*.rs" ' +
@@ -105,7 +104,6 @@ describe('vault pepper invariants', () => {
     // Any reference to ANOTHER artifact name in the same function body
     // is a red flag.
     const rotateBody = execSync(
-      // eslint-disable-next-line no-restricted-syntax
         'sed -n "/^export function rotateVaultStatePepper/,/^}/p" ' +
         'src/infra/storage/rust-vault-adapter.ts',
       { cwd: REPO_ROOT, encoding: 'utf8' },
```

## Verification post-apply

```bash
npx eslint tests/unit/vault-pepper-invariants.test.ts
# Expected: ✖ 0 problems
npm test -- tests/unit/vault-pepper-invariants.test.ts
# Expected: all tests pass (no behavior change)
```

## Disposition options

**Option 1 (preferred): bundle into Codex round-N hotfix.** When Coder A opens the round-N hotfix PR for #593 + #594 (W1 silent-catch, W2 process.cwd, N1 JSON.parse guard) — add this 2-line cleanup to the same PR. Single PR for all post-merge cleanups.

**Option 2: standalone micro-PR.** Branch `fix/vault-pepper-invariants-unused-eslint-disable`. ~30 seconds of work. Open if Codex round-N is far off.

**Option 3: skip.** Warnings aren't blocking CI normally (they're warnings, not errors). The `--no-verify` bypass only matters in pre-commit hooks configured `--max-warnings 0`. If operator never uses --no-verify again, the warnings are tolerable. NOT recommended — fix is 2 lines.

— Coder B
