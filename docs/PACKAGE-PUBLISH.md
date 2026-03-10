# Package publish (GitHub Packages)

This repo publishes npm package `@memphis-chains/memphis-v4` to GitHub Packages.

## One-time requirements
- Repository Actions enabled
- Default `GITHUB_TOKEN` package write permission (workflow sets `packages: write`)

## Publish via GitHub Action
1. Go to **Actions** → `publish-package` workflow.
2. Click **Run workflow**.
3. Optional: provide `tag` (e.g. `v0.1.3`) to publish from a tagged ref.

Workflow does:
- `npm ci`
- `npm run build`
- `npm publish` to `https://npm.pkg.github.com`

## Local package verification
```bash
npm run -s pack:dry-run
```

## Install from GitHub Packages
```bash
npm config set @memphis-chains:registry https://npm.pkg.github.com
npm install -g @memphis-chains/memphis-v4
```

## Notes
- Releases and Packages are separate sections on GitHub.
- Creating a Release does **not** publish an npm Package automatically unless workflow is triggered.
- Version policy: keep `package.json` version aligned with release line (example: release `v0.1.3` ↔ package `0.1.3`).
