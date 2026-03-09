# Onboarding / Install Path (Increment)

## Quick install
```bash
npm install
cp .env.example .env
npm run build
```

## Preflight doctor
Run before first real usage:
```bash
npx tsx src/infra/cli/index.ts doctor --json
```

Checks now include:
- Node runtime version
- rust bridge enable flag (`RUST_CHAIN_ENABLED`)
- rust bridge path (`RUST_CHAIN_BRIDGE_PATH`)
- embed API availability from bridge
- vault pepper configured (`MEMPHIS_VAULT_PEPPER` len >= 12)

## Ask path
New ergonomic ask alias:
```bash
npx tsx src/infra/cli/index.ts ask --input "Summarize this log"
npx tsx src/infra/cli/index.ts ask --input "Quick answer" --tui
```

`--tui` provides a framed terminal output for faster operator reading.
