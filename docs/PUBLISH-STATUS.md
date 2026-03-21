# Publish Status

Last verified: 2026-03-21

## GitHub Packages target

- Workflow: `publish-package`
- Registry: `https://npm.pkg.github.com`
- Package name: `@memphis-chains/memphis`
- CLI binary: `memphis`

Install example:

```bash
npm config set @memphis-chains:registry https://npm.pkg.github.com
npm install -g @memphis-chains/memphis
```

## Releases

- Release workflow: `.github/workflows/release.yml`
- Tag format: `vX.Y.Z`

## Notes

- This document tracks publication alignment, not an asserted successful publish run.
- Re-run `npm run release:smoke` and trigger the relevant workflow before the next release.
