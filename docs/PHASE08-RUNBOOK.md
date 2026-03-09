# PHASE 08 Runbook

## Validate tooling
```bash
npm run -s ops:phase08-verify-tooling
```

## Run full smoke pack
```bash
npm run -s ops:phase08-smoke-pack
```

## Run smoke pack with report output
```bash
npm run -s ops:phase08-smoke-pack:report
```

## Cleanup runtime artifacts
```bash
npm run -s ops:phase08-clean
```

## Troubleshooting

- If verify fails: run `npm run -s ops:phase08-verify-tooling` and install missing deps/scripts.
- If smoke pack fails: inspect retrieval report artifacts and rerun with report mode.
- If workspace gets noisy: `npm run -s ops:phase08-clean`.

## Check runtime status
```bash
npm run -s ops:phase08-status
```
