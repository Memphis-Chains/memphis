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

The release artifact is package-first. The full solo-local runtime workflow documented for operators remains the source checkout plus bootstrap path in `README.md` and `docs/GETTING-STARTED.md`.

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

This gate covers:

- quality/runtime pack checks
- acceptance smoke flow
- package dry-run
- secret scan

## Release steps

1. Ensure the working tree is clean.
2. Confirm `main` matches the intended release state.
3. Run `npm run release:smoke`.
4. Bump version and tag via `scripts/release.sh`.
5. Push the tag.
6. Verify the GitHub Actions release workflow completed and attached the npm tarball asset.
7. If needed, trigger `publish-package` for a package-only re-run.

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
