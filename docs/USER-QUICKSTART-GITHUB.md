# Memphis v4 — User Quickstart (GitHub)

For users who just want to install Memphis and start using it quickly.

## 1) Clone repository

```bash
git clone https://github.com/Memphis-Chains/memphis-v4.git
cd memphis-v4
```

## 2) Install dependencies

Preferred:
```bash
./scripts/install.sh
```

Manual fallback:
```bash
npm install
cp .env.example .env
```

## 3) Build and smoke-check

```bash
npm run build
npm test
```

## 4) First run

Run CLI directly:
```bash
npx tsx src/infra/cli/index.ts doctor --json
npx tsx src/infra/cli/index.ts ask --input "Hello Memphis"
```

Optional TUI mode:
```bash
npx tsx src/infra/cli/index.ts tui
```

## 5) Common commands

```bash
# Check health/status
npx tsx src/infra/cli/index.ts doctor --json
npx tsx src/infra/cli/index.ts status --json

# Ask assistant
npx tsx src/infra/cli/index.ts ask --input "Summarize current setup"

# External-proof local-ready ops
npm run -s ops:phase8-external-proof-readiness -- node-a.prod.example node-b.prod.example
npm run -s ops:phase8-external-proof-pack -- /tmp/mv4-phase8-external-pack node-a.prod.example node-b.prod.example
```

## What you get after install

- Production-first Memphis runtime (TypeScript shell + Rust core bridge)
- CLI and TUI operator workflows
- Built-in quality gates and smoke scripts
- Local-ready external-proof flow (with READY/BLOCKED readiness semantics)

## Important note

Full final two-host production capture is environment-dependent (requires two real hosts). Current local-ready path is production-hardened and validated in CI/smoke gates.
