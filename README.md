# Memphis v5

> **OpenClaw executes. Memphis remembers.**

Memphis v5 is a production-ready, local-first cognitive memory layer for agent systems.
It provides persistent memory, semantic recall, encrypted secrets, and operational tooling for reliable AI workflows.

## Vision

Memphis exists to make AI systems durable, auditable, and sovereign:

- **Durable**: memory survives sessions and restarts
- **Auditable**: decision and history flows are traceable
- **Sovereign**: data and crypto stay under operator control

## Quick Start (3 commands)

```bash
git clone https://github.com/Memphis-Chains/memphis-v5.git
cd memphis-v5
./scripts/install.sh && npm run -s cli -- doctor --json
```

If `doctor` returns `"ok": true`, your runtime is healthy.

## Features

- **Local-first memory runtime** (TypeScript shell + Rust core bridge)
- **Semantic retrieval pipeline** for context recall
- **Cryptographic safety path** (Argon2id, AES-256-GCM, Ed25519 tracks)
- **CLI + ops automation** for smoke gates, closure checks, and release validation
- **MCP server support** for tool integration (stdio / HTTP transport)
- **Production hardening**: auth policy, rate limiting, health/status endpoints

## Architecture (high-level)

```text
┌───────────────────────────────────────────────────────────┐
│                    Clients / Operators                    │
│              CLI • TUI • API • MCP consumers             │
└──────────────────────────┬────────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────────┐
│              TypeScript Runtime Orchestration            │
│  config profiles • provider policy • ops • observability │
└──────────────────────────┬────────────────────────────────┘
                           │ N-API bridge
┌──────────────────────────▼────────────────────────────────┐
│                        Rust Core                         │
│     chain integrity • secure vault • native primitives   │
└──────────────────────────┬────────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────────┐
│                    Local Data Storage                     │
│           chain state • vault state • retrieval index     │
└───────────────────────────────────────────────────────────┘
```

## Installation options

- **Fast local install**: `./scripts/install.sh`
- **Manual setup**:
  1. Install Node.js 20+ and Rust/Cargo
  2. `npm install`
  3. `npm run build`
- **Package-oriented flow**: `npm pack --dry-run` then consume tarball in controlled environments

## Core commands

```bash
npm run -s cli -- help
npm run -s cli -- doctor --json
npm run -s cli -- health --json
npm test
npm run build
```

## Documentation

- [Quickstart](docs/QUICKSTART.md)
- [User Guide](docs/USER-GUIDE.md)
- [Architecture Map](docs/ARCHITECTURE-MAP.md)
- [Release Process](docs/RELEASE-PROCESS.md)
- [Operator 5-min Runbook](docs/OPERATOR-5MIN-RUNBOOK.md)
- [Contributing Guide](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

MIT — see [LICENSE](LICENSE).
