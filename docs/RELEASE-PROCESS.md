# RELEASE-PROCESS.md — memphis

This is the current release process for the `memphis` repository.

## Canonical refs

- Canonical architecture: `docs/CANONICAL-ARCHITECTURE.md`
- Execution plan: `docs/EXECUTION-PLAN.md`
- Must-pass smoke gate: `docs/MUST-PASS-SMOKE.md`
- Package publish guide: `docs/PACKAGE-PUBLISH.md`

## Product names

- GitHub repository: `Memphis-Chains/memphis`
- npm package: `@memphis-chains/memphis`
- CLI binary: `memphis`

The release artifact is the package distribution unit. The full solo-local
runtime workflow documented for operators remains the source checkout plus
bootstrap path in `README.md` and `docs/GETTING-STARTED.md`.

## Release channels

There are two publication paths:

1. Tag-driven release workflow (`.github/workflows/release.yml`)
   - runs the release smoke gate
   - packs a single npm tarball release asset
   - creates the GitHub Release
   - publishes the npm package to GitHub Packages

2. Manual package publish workflow (`.github/workflows/publish-package.yml`)
   - re-publishes from a selected tag
   - uses the same release smoke gate before publishing

## Local release gate

Before tagging or publishing, run:

```bash
npm run release:smoke
```

If you changed release entrypoints, RC scripts, or Rust TUI startup behavior,
re-run the clean-environment proof explicitly:

```bash
npm run ops:rc-drill:fresh-env
```

This gate covers:

- quality/runtime pack checks
- GA convergence smoke across CLI, TUI, HTTP, MCP, and Telegram readiness
- non-mutating installer contract verification (`bash ./scripts/install.sh --check-only --json`)
- fresh-environment RC drill against a temp runtime root with clean XDG/npm env state
- native Rust TUI startup sanity via `memphis tui --check-only --json`
- source-checkout bootstrap, CLI chat/memory/vault, semantic recall, exact search, HTTP health/chat, and MCP sanity in one isolated run
- temp-prefix package install validation of the packed CLI artifact
- bounded Matrix trusted-pilot setup truth and vault-backed config expectations
- secret scan

Active surface truth for this gate:

- Rust TUI is the only active TUI path
- the old TypeScript TUI is archived under `legacy/tui-ts/`
- Matrix remains optional trusted pilot only
- OpenClaw remains deprecated/downstream only

## Release steps

1. Ensure the working tree is clean.
2. Confirm `main` matches the intended release state.
3. Run `npm run release:smoke`.
4. Re-run `npm run ops:rc-drill:fresh-env` explicitly if you changed release entrypoints, RC scripts, or Rust TUI startup behavior.
5. Bump version and tag via `scripts/release.sh`.
6. Push the tag.
7. Verify the GitHub Actions release workflow completed and attached the npm tarball asset.
8. If needed, trigger `publish-package` for a package-only re-run.

## Versioning discipline

- Keep `package.json` version aligned with the release tag.
- Tag format: `vX.Y.Z`.
- Do not publish ad-hoc package versions that do not map to a Git tag.

## Rollback

If a release is broken:

1. Identify the last known good tag.
2. Revert the offending commit group.
3. Cut a hotfix release.
4. Publish the hotfix through the same workflow path.
