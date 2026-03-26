# Package publish (GitHub Packages)

This repository publishes the npm package `@memphis-chains/memphis` to GitHub Packages.

This is the release and CLI distribution unit. The currently documented and
supported full solo-local operator workflow still uses a source checkout plus
bootstrap.

## One-time requirements

- Repository Actions enabled
- `GITHUB_TOKEN` has package write permission in the workflow
- `package.json` version is aligned with the intended release tag

## Publish paths

### Tag-driven release

A push of a `v*` tag runs `.github/workflows/release.yml`, which:

- runs the release smoke gate,
- packs a single npm tarball release asset,
- creates a GitHub Release,
- publishes the npm package.

### Manual package publish

The `.github/workflows/publish-package.yml` workflow can be run from the Actions tab and publishes from a selected tag.
The `tag` input is required and must start with `v`.

## Local verification before publish

Run the release gate and package validator locally:

```bash
npm run release:smoke
npm run -s ops:validate-package-artifact
```

## Install from GitHub Packages

```bash
npm config set @memphis-chains:registry https://npm.pkg.github.com
npm install -g @memphis-chains/memphis
```

This package install path is currently a bounded CLI/distribution path. The
canonical full-runtime GA path remains source checkout plus bootstrap.

## Notes

- Creating a GitHub Release does not by itself guarantee a package publish unless the release workflow completes successfully.
- The GitHub Release carries the packed `.tgz` asset, not cross-platform binary bundles.
- Keep the package name, binary name, and docs aligned with the current repo:
  - package: `@memphis-chains/memphis`
  - binary: `memphis`
  - repository: `Memphis-Chains/memphis`
