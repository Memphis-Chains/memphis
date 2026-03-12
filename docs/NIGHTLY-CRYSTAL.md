# Nightly Crystal Pass

This repo now includes an automated nightly quality pass intended to keep code quality stable while development moves fast.

## Local usage

Run check-only:

```bash
npm run -s ops:nightly-crystal
```

Run with JSON output:

```bash
npm run -s ops:nightly-crystal:json
```

Run with autofix enabled:

```bash
npm run -s ops:nightly-crystal:autofix
```

Optional flags:

- `--skip-tests`
- `--skip-build`
- `--skip-bench`
- `--skip-security`

Example:

```bash
npm run -s ops:nightly-crystal -- --autofix --skip-tests
```

Reports are written to:

- `.memphis-intake/nightly-quality/latest.json`
- `.memphis-intake/nightly-quality/nightly-<timestamp>.json`

## GitHub Actions schedule

Workflow:

- `.github/workflows/nightly-crystal.yml`

Schedule:

- daily at `02:15 UTC`

It runs the same script in JSON mode and uploads the report as an artifact.

## Included checks

- format check
- lint
- typecheck
- secret scan
- npm dependency audit (`--omit=dev --audit-level=high`)
- test
- retrieval benchmark gate
- build

## Branch protection automation

To enforce `main` branch protection from CLI:

```bash
GITHUB_TOKEN=<repo-admin-token> npm run -s ops:protect-main
```

This applies:

- required `quality-gate` status check
- linear history
- review requirement (1 approval)
- stale review dismissal
- admin enforcement
- conversation resolution requirement
