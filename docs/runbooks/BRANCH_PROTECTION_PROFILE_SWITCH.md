# Branch Protection Profile Switch (`team` / `solo`)

Use this runbook to safely switch `main` branch protection policy between:

- `team`: requires 1 approving review
- `solo`: requires 0 approving reviews

Both profiles still require `quality-gate` and keep admin/force-push protections enabled.

## Preconditions

1. `GITHUB_TOKEN` (or `GH_TOKEN`) has repo admin permission.
2. You are in repository root (`MemphisOS`).
3. Target repo/branch is explicit (`GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`).

## 1. Verify Current Protection

```bash
GITHUB_OWNER=Memphis-Chains \
GITHUB_REPO=MemphisOS \
GITHUB_BRANCH=main \
npm run -s ops:verify-main-protection
```

Expected output ends with:

`[verify-branch-protection] OK for ... (profile=<current-profile>)`

## 2. Apply New Profile

Switch to `team`:

```bash
MEMPHIS_BRANCH_PROTECTION_PROFILE=team \
GITHUB_OWNER=Memphis-Chains \
GITHUB_REPO=MemphisOS \
GITHUB_BRANCH=main \
npm run -s ops:protect-main
```

Switch to `solo`:

```bash
MEMPHIS_BRANCH_PROTECTION_PROFILE=solo \
GITHUB_OWNER=Memphis-Chains \
GITHUB_REPO=MemphisOS \
GITHUB_BRANCH=main \
npm run -s ops:protect-main
```

## 3. Verify New Profile

```bash
MEMPHIS_BRANCH_PROTECTION_PROFILE=<team|solo> \
GITHUB_OWNER=Memphis-Chains \
GITHUB_REPO=MemphisOS \
GITHUB_BRANCH=main \
npm run -s ops:verify-main-protection
```

The verify profile must match the one you just applied.

## 4. Rollback Procedure

If verification fails or unexpected policy drift appears:

1. Re-apply known-good profile (`team` recommended default).
2. Re-run `ops:verify-main-protection`.
3. Capture command output in incident notes.

## Failure Cases

- `HTTP 401 Bad credentials`: token invalid/expired.
- `Invalid MEMPHIS_BRANCH_PROTECTION_PROFILE`: value must be `team` or `solo`.
- `Policy mismatch` / `Required review count mismatch`: profile drift; re-apply and verify.
