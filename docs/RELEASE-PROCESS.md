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

There are three distinct release paths:

1. Release candidate path (canonical pre-GA path)
   - prepare the repo with `./scripts/prepare-release-candidate.sh --version <semver-prerelease>`
   - dispatch `.github/workflows/release-draft-dispatch.yml`
   - creates a draft GitHub release with candidate artifacts and validator metadata
   - does **not** publish the npm package

2. Final GA / hotfix tag path
   - use `./scripts/release.sh [patch|minor|major|--version <semver>]`
   - pushes a real tag that triggers `.github/workflows/release.yml`
   - publishes the package only after RC signoff or for a real hotfix

3. Manual package publish workflow
   - `.github/workflows/publish-package.yml`
   - re-publishes from an existing tag
   - not the canonical RC path

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

## Candidate steps

1. Ensure tracked changes are committed and `main` matches the intended RC state.
2. Run `npm run release:smoke`.
3. Re-run `npm run ops:rc-drill:fresh-env` explicitly if you changed release entrypoints, RC scripts, or Rust TUI startup behavior.
4. Prepare the repo for the candidate with `./scripts/prepare-release-candidate.sh --version <semver-prerelease>`.
5. Push `main`.
6. Dispatch `.github/workflows/release-draft-dispatch.yml` with matching `version=<semver-prerelease>`.
7. Verify the draft GitHub release contains the tarball, checksum, and validator metadata artifacts.

## Final publish after RC signoff

1. Update the repo to the final GA version with `./scripts/release.sh --version <semver>` or a bump type.
2. Push the final tag.
3. Verify `.github/workflows/release.yml` completed successfully.
4. If needed, trigger `publish-package` for a package-only re-run.

## Versioning discipline

- Keep `package.json` version aligned with the candidate or release workflow input.
- RC versions should be semver prereleases such as `1.0.0-rc.1`.
- Final tag format: `vX.Y.Z` (or another semver-compatible explicit version when using `--version`).
- Do not publish ad-hoc package versions that do not map to a Git tag.

## Rollback

If a release is broken:

1. Identify the last known good tag.
2. Revert the offending commit group.
3. Cut a hotfix release.
4. Publish the hotfix through the same workflow path.
