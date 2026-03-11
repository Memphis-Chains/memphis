# Memphis v5 — Dependency & Infrastructure Audit Report

**Date:** 2026-03-11  
**Repo:** `/home/memphis_ai_brain_on_chain/memphis-v5`  
**Phase:** Pre-v1.0.0 dependency health check

---

## Executive Summary

- ✅ **NPM security audit (root): clean** (`0` vulnerabilities).
- ⚠️ **2 outdated npm dev packages** at root (`@types/node`, `typescript-eslint`).
- ⚠️ **Potential unnecessary runtime dependency:** `pino` appears unused in `src/` and `tests/`.
- ⚠️ **Rust toolchain not available in this environment** (`cargo: command not found`), so full `cargo audit`/`cargo outdated` could not be executed here.
- ⚠️ **Script hygiene gap:** 3 shell scripts are not using strict mode header (`set -euo pipefail`).
- ✅ **License posture looks permissive overall** (MIT/ISC/BSD/Apache), with one dual-license transitive package that should be policy-reviewed.
- ✅ **Publish artifact size is small** (`137.7 kB` packed, `561.7 kB` unpacked).

---

## 1) NPM Dependencies

### Security (root package)

Command: `npm audit --json`

- **Vulnerabilities:** `0 total`
  - critical: 0
  - high: 0
  - moderate: 0
  - low: 0

### Outdated packages (root)

Command: `npm outdated --json`

- `@types/node`: `25.3.5` → `25.4.0`
- `typescript-eslint`: `8.56.1` → `8.57.0`

### Unnecessary dependencies

Command: `npx depcheck --json`

- Reported potentially unused dependency:
  - `pino`

Manual cross-check:

- No direct `pino` usage found in `src/` or `tests/` via grep.
- Current logger implementation is custom (`src/infra/logging/logger.ts`) and does not import pino.

**Recommendation:**

- Remove `pino` from root dependencies unless runtime dynamic import exists outside scanned paths.

### License compliance (production deps)

Command: `npx license-checker --json --production`

Observed licenses in prod tree are mainly:

- MIT, ISC, BSD-2/3-Clause, Apache-2.0

Potential policy review item:

- `expand-template` is `(MIT OR WTFPL)` (transitive).

**Recommendation:**

- If your org disallows WTFPL even in dual-license transitive deps, add a policy exception workflow or force replacement path.

### Bundle/package size impact

Commands:

- `npm pack --dry-run`
- `du -sh node_modules dist target`

Results:

- NPM package tarball: **137.7 kB**
- Unpacked publish contents: **561.7 kB**
- Included files: **149**
- Local dependency footprint:
  - `node_modules`: **160M**
  - `dist`: **1.1M**
  - Rust `target`: **551M**

Interpretation:

- Publish artifact is lean.
- Local build footprint is dominated by Rust build cache (`target`) and Node install tree.

---

## 2) Rust Dependencies

### Security vulnerabilities

Attempted commands:

- `cargo audit --json`
- `cargo outdated --depth 1 --root-deps-only --format json`

Result:

- ❌ Could not run because `cargo` is unavailable in this environment (`command not found`).

### Version freshness (direct crate check via crates.io API)

Direct non-workspace, non-path deps detected:

- `napi` `3` (latest `3.8.3`) ✅ major-current
- `napi-derive` `3` (latest `3.5.2`) ✅ major-current
- `aes-gcm` `0.10` (latest `0.10.3`) ✅
- `argon2` `0.5` (latest `0.5.3`) ✅
- `sha2` `0.10` (latest `0.10.9`) ✅
- `hex` `0.4` (latest `0.4.3`) ✅
- `zeroize` `1` (latest `1.8.2`) ✅
- `ed25519-dalek` `2.1` (latest `2.2.0`) ⚠️ minor behind
- `base64-url` `2` (latest `3.0.2`) ⚠️ major behind (breaking changes likely)
- `rand` `0.8` (latest `0.10.0`) ⚠️ major behind (breaking changes likely)

Cargo.lock package count:

- **117** packages

### Build time / binary size impact notes

- Workspace includes crypto-heavy crates (`argon2`, `aes-gcm`, `ed25519-dalek`) and N-API bindings (`napi`, `napi-derive`), which increase compile time.
- `target/` currently at **551M**, indicating substantial compiled artifact/cache footprint.

**Recommendations:**

1. Run full Rust checks in a Rust-enabled environment:
   - `cargo audit`
   - `cargo outdated`
   - `cargo bloat -n 20 --release` (per crate)
2. Prioritize upgrade feasibility review for:
   - `ed25519-dalek` 2.2.x
   - `base64-url` 3.x
   - `rand` 0.10.x
3. Consider release profile tuning if binary size is a concern (LTO/codegen-units/panic=abort where appropriate).

---

## 3) Dev Dependencies / Toolchain

Root dev stack appears healthy and standard:

- Testing: `vitest`
- Build/run: `typescript`, `tsx`
- Lint/format: `eslint`, `typescript-eslint`, `prettier`
- Docs: `typedoc`

Outdated dev deps:

- `@types/node`, `typescript-eslint` (minor/patch level)

**Recommendation:**

- Safe update path:
  1. `npm i -D @types/node@latest typescript-eslint@latest`
  2. `npm run lint && npm run typecheck && npm run test`

---

## 4) Configuration Files

### `package.json` health

Strengths:

- Proper metadata (repository, homepage, bugs, license).
- `files` whitelist keeps publish output tight.
- Good script coverage (test/build/smoke/ops).

Potential improvements:

- Add `engines` (Node and npm versions) at root for install consistency.
- Add `packageManager` field (e.g. `npm@x.y.z`) for deterministic CI/local behavior.
- Script surface is very large; consider script grouping wrappers to reduce maintenance overhead.

### `tsconfig.json` optimization

Current config is generally sane (`strict`, NodeNext, ES2022).

Potential improvements:

- Consider explicit `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` for stricter safety pre-1.0.
- Keep `skipLibCheck: true` for speed unless debugging type package issues.

### `Cargo.toml` review

- Workspace structure and shared deps are clean (`resolver = "2"`, centralized workspace deps).
- Good use of path dependencies across internal crates.

Potential improvements:

- Pin/review minimum Rust version (`rust-version`) in each crate for clearer compatibility policy.

### `.env.example` completeness

- Good coverage across runtime, provider, vault, gateway hardening, alerting.
- Includes secure defaults for `GATEWAY_EXEC_RESTRICTED_MODE=true`.

Potential improvements:

- Add comments marking **required in production** variables in one consolidated section at top.
- Consider adding example format constraints for token fields.

---

## 5) Scripts Quality

### Script inventory

- Shell scripts in `scripts/`: **90**
- Root package script paths validated: ✅ all referenced `./scripts/*.sh` exist.

### Strict mode compliance

Checked for missing `set -euo pipefail` line:

- `scripts/capture-evidence.sh`
- `scripts/install.sh`
- `scripts/local-quality-runtime-pack.sh`

Notes:

- `scripts/install.sh` uses `set -Eeuo pipefail` (strict, with ERR trap), but simple header check flagged it.
- `scripts/local-quality-runtime-pack.sh` uses only `set -u` (partial strictness).
- `scripts/capture-evidence.sh` has no strict header.

**Recommendation:**

- Normalize shell policy across all scripts:
  - `#!/usr/bin/env bash`
  - `set -Eeuo pipefail`
  - optional: `IFS=$'\n\t'`

### CI/CD toolchain review (`.github/workflows`)

- CI workflow runs Node quality gates + `cargo test --workspace`.
- Potential fragility: CI file does not explicitly install Rust in `ci.yml` (unlike `publish-package.yml`, which does).

**Recommendation:**

- Add Rust setup step to `ci.yml` (`dtolnay/rust-toolchain@stable`) before cargo commands for deterministic CI.

---

## Vulnerability List

### NPM (root)

- **None found** (`npm audit`: 0 vulnerabilities).

### Rust

- **Not assessed in this environment** due missing cargo toolchain.

### Notable risk items (non-CVE)

- Potential unused runtime dependency: `pino`
- Dual-license transitive package: `expand-template (MIT OR WTFPL)`
- Rust deps with major-version gap: `rand`, `base64-url`

---

## Prioritized Update & Refactor Plan

### P0 (before v1.0.0)

1. Run Rust security/outdated scans in Rust-enabled environment (`cargo audit`, `cargo outdated`) and attach output.
2. Remove `pino` if confirmed unused.
3. Add Rust setup step to CI workflow (`ci.yml`).

### P1

1. Bump minor/patch outdated npm dev deps (`@types/node`, `typescript-eslint`).
2. Standardize strict shell mode in remaining non-compliant scripts.

### P2

1. Evaluate upgrade paths for `ed25519-dalek`, `rand`, `base64-url` with compatibility testing.
2. Add `engines` + `packageManager` to root `package.json`.
3. Optional TypeScript strictness tightening (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).

---

## Commands Executed (audit evidence)

- `npm audit --json`
- `npm outdated --json`
- `npm ls --depth=0 --json`
- `npx --yes depcheck --json`
- `npx --yes license-checker --json --production`
- `npm pack --dry-run`
- `du -sh node_modules dist target`
- `find scripts ...`
- `grep -L '^set -euo pipefail' scripts/*.sh`
- `cargo audit --json` (failed: cargo missing)
- `cargo outdated ...` (failed: cargo missing)

---

**Audit status:** Partial-complete with explicit tooling limitation on Rust security scan due missing `cargo` in current runtime.
