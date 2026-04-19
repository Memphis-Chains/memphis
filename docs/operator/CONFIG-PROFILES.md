# Config Profiles (S4.3)

## development

- verbose-friendly defaults
- no strict production token requirement

## production

- requires `MEMPHIS_API_TOKEN`
- safe caps applied:
  - `GEN_TIMEOUT_MS <= 20000`
  - `GEN_MAX_TOKENS <= 1024`
- `LOG_LEVEL=debug` auto-normalized to `info`

## test

- debug log normalized to error to reduce noise
