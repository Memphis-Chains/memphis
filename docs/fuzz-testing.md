# Fuzz Testing (Chain Validation)

This project includes property-style fuzz tests for input validation hardening.

## Scope

Target file: `tests/fuzz/chain-validation.fuzz.test.ts`

Implemented fuzz targets:

1. **Chain entry validation**
   - malformed JSON payloads
   - invalid hashes (missing/invalid hash fields)
   - corrupt indexes (`NaN`)
   - broken `prev_hash` link integrity
2. **Embed query validation**
   - empty query
   - whitespace-only query
   - huge query payloads
   - special/control chars (null byte)
3. **CLI input validation**
   - missing required flags (`embed search`, `chain import_json`, `vault add`)
   - unknown command edge cases
   - valid baseline command sanity checks

## Iteration control

- Environment variable: `FUZZ_ITERATIONS`
- Default: `100`

Examples:

```bash
npm run test:fuzz
FUZZ_ITERATIONS=250 npm run test:fuzz
```

## CI/Test suite integration

- `package.json` adds script: `test:fuzz`
- `scripts/test.sh` now runs: `test:rust` -> `test:ts` -> `test:fuzz` -> `test:smoke`
- `.github/workflows/ci.yml` sets `FUZZ_ITERATIONS=100` for the `npm run test` step

## Performance goal

Fuzz tests are designed to stay fast and local-only:

- no external network/service dependency
- bounded payload sizes and deterministic limits
- intended total runtime under ~10s on CI-class hardware
