# Post-GA Bug Review - 2026-03-27

## Scope

Quick post-`v1.0.0` review focused on concrete bugs or release-grade blind spots visible in the repo after GA.

## Findings

### 1. `bin/memphis.js` has a dead source fallback

Severity: medium

Files:
- `bin/memphis.js:12-33`

Why this is a bug:
- The launcher falls back from `dist/infra/cli/index.js` to `src/infra/cli/index.ts`.
- In plain Node 22, importing the TypeScript source path does not work as a valid fallback because the source tree imports generated `.js` module paths that do not exist in raw source execution.

Evidence:
- `node -e "import('./src/infra/cli/index.ts')..."` fails with:
  - `ERR_MODULE_NOT_FOUND`
  - `Cannot find module '/home/memphis_ai_brain_on_chain/memphis/src/infra/cli/dispatcher.js'`

Impact:
- Packaged installs are fine because `dist/` exists.
- Dev or broken-build launch scenarios can fail in a misleading way instead of giving a clean “build missing” error.

Suggested fix:
- Remove the raw `.ts` fallback from `bin/memphis.js`, or make the fallback explicit through a supported dev runner such as `tsx`.
- Prefer fail-closed with a clear message if `dist/` is missing.

### 2. `openclaw-plugin` is a green-build package that does not actually build or work

Severity: medium

Files:
- `openclaw-plugin/package.json:5-10`
- `openclaw-plugin/src/index.ts:42-224`

Why this is a bug:
- The package declares `main: dist/index.js` and `types: dist/index.d.ts`.
- `npm run build` exits successfully, but there is no `dist/` output and no manifest file.
- The implementation itself is still placeholder-level:
  - `search()` is TODO-backed and only searches in-memory `journal` blocks
  - `add()` does not append to Memphis chains
  - `loadChains()` is TODO-backed and never called

Evidence:
- `npm run build` inside `openclaw-plugin/` returns success
- `openclaw-plugin/dist/index.js` is missing
- `openclaw-plugin/openclaw.plugin.json` is missing
- `find openclaw-plugin -maxdepth 2 -type f` returns only:
  - `openclaw-plugin/package.json`
  - `openclaw-plugin/src/index.ts`

Impact:
- Anyone touching the deprecated downstream OpenClaw path gets a package that looks publishable but is not actually usable.
- This is especially misleading because the build step does not fail.

Suggested fix:
- Choose one:
  - archive/delete the package entirely from active repo surfaces, or
  - make it honestly buildable with real outputs and a minimal working implementation.

### 3. Package artifact validation is too weak for the shipped product shape

Severity: medium

Files:
- `scripts/validate-package-artifact.mts:171-210`

Why this is a bug:
- The validator installs the packed tarball correctly, but the only CLI probe is `memphis completion bash`.
- That proves the binary launches, not that the shipped package can exercise the product’s real operator path.

Evidence:
- `runCliProbe()` only executes:
  - `memphis completion bash`

Impact:
- A packaged regression in Rust TUI launch, native operator bootstrap, or basic command wiring could slip through while package validation still passes.
- This is a release-quality blind spot, not just missing convenience coverage.

Suggested fix:
- Extend the artifact validator to probe at least:
  - `memphis tui --check-only --json`
  - one bounded health/status command
  - optionally one no-network chat sanity using `local-fallback`

### 4. Active published package still ships deprecated OpenClaw integration docs

Severity: low

Files:
- `package.json:13-31`

Why this is a bug:
- The published package file list still includes `docs/OPENCLAW-INTEGRATION.md`.
- Product truth says OpenClaw is deprecated/downstream only, but the shipping package still foregrounds that doc as part of the installable artifact.

Impact:
- Not a runtime failure, but it adds post-GA product-truth drift in the published artifact.
- It increases the chance that operators discover a deprecated path first.

Suggested fix:
- Remove deprecated OpenClaw docs from the published package file list unless there is a deliberate archival reason to keep them.

## Commands used

- `rg -n "TODO|FIXME|HACK|XXX|BUG|FLAKY|DEPRECATED" -S . --glob '!legacy/**' --glob '!node_modules/**' --glob '!dist/**'`
- `node -e "import('./src/infra/cli/index.ts')..."`
- `cd openclaw-plugin && npm run build`
- `find openclaw-plugin -maxdepth 2 -type f | sort`
- `test -e openclaw-plugin/dist/index.js && echo dist-exists || echo dist-missing`
- `test -e openclaw-plugin/openclaw.plugin.json && echo manifest-exists || echo manifest-missing`

