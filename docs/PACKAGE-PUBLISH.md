# Package publish (GitHub Packages)

This repository publishes the npm package `@memphis-chains/memphis` to GitHub Packages.

This is the release and bounded CLI distribution unit. The canonical
full-runtime operator workflow uses source checkout plus bootstrap.

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

Run the shared release gate wrapper and package validator locally:

```bash
bash ./scripts/run-release-gates.sh
npm run -s ops:validate-package-artifact
```

The package validator verifies the packaged CLI surface only. The Rust TUI
proof is the source-checkout RC drill (`npm run ops:rc-drill:fresh-env`), not
the temp-prefix package install.

## Install from GitHub Packages

```bash
npm config set @memphis-chains:registry https://npm.pkg.github.com
npm install -g @memphis-chains/memphis
```

This package install path is a bounded CLI/distribution surface. The canonical
full-runtime GA path stays source checkout plus bootstrap.

## Notes

- Creating a GitHub Release does not by itself guarantee a package publish unless the release workflow completes successfully.
- The GitHub Release carries the packed `.tgz` asset, not cross-platform binary bundles.
- Keep the package name, binary name, and docs aligned with the current repo:
  - package: `@memphis-chains/memphis`
  - binary: `memphis`
  - repository: `Memphis-Chains/memphis`
