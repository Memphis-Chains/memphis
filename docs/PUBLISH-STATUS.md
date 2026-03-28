# Publish Status

Last verified: 2026-03-28

## Current release truth

- latest published release: `v1.0.1`
- package name: `@memphis-chains/memphis`
- current `main`: post-`v1.0.1` documentation/status correction lane
- no newer release is implied by current repo docs unless a later tag says so

This document tracks publication truth, not product-roadmap truth. Use
`docs/PROJECT-STATUS.md` and `docs/ROADMAP-CURRENT.md` for current maturity and
planning.

## GitHub Packages target

- Workflow: `publish-package`
- Registry: `https://npm.pkg.github.com`
- Package name: `@memphis-chains/memphis`
- CLI binary: `memphis`
- License: `Apache-2.0`

Install example:

```bash
npm config set @memphis-chains:registry https://npm.pkg.github.com
npm install -g @memphis-chains/memphis
```

## Releases

- Release workflow: `.github/workflows/release.yml`
- Tag format: `vX.Y.Z`
- Current published tag verified in-repo: `v1.0.1`

## Notes

- GitHub Releases and GitHub Packages publish the packaged artifact and bounded
  CLI distribution surface.
- The canonical full local runtime path remains source checkout plus bootstrap.
- Public GitHub Packages visibility does not remove the need to verify
  GitHub-Packages auth behavior when testing installs from `npm.pkg.github.com`.
- Re-run `npm run release:smoke` and trigger the relevant workflow before the
  next release.
