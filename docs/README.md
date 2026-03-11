# Memphis v5 Documentation

## Quick Links
- [Quick Start](#quick-start) — Get running in 5 minutes
- [Installation Guide](#installation) — Complete installation
- [API Reference](#api-reference) — CLI commands
- [Troubleshooting](#troubleshooting) — Common issues

<a id="installation"></a>

## Installation & Setup

### Prerequisites
- [Prerequisites](./PREREQUISITES.md) — Hardware/software requirements
- [Platform Notes](./PLATFORM-NOTES.md) — Ubuntu/Debian/Fedora/WSL specific

### Installation
- [Installation Guide](./INSTALLATION.md) — Basic installation
- [Ollama Setup](./OLLAMA-SETUP.md) — Ollama installation
- [Post-Installation](./POST-INSTALLATION.md) — First-time setup
- [Re-Install Guide](./RE-INSTALL.md) — Complete reinstall

### Configuration
- [Configuration](./CONFIGURATION.md) — Config reference
- [Quick Start Scenarios](./QUICK-START-SCENARIOS.md) — 5 use cases

## Testing & Verification
- [Testing Guide](./TESTING-VERIFICATION.md) — Smoke tests
- [Troubleshooting](./TROUBLESHOOTING.md) — Common issues
- [Decision Tree](./TROUBLESHOOTING-DECISION-TREE.md) — Debug flowcharts

## Integration
- [OpenClaw Integration](./OPENCLAW-INTEGRATION.md) — Plugin setup
- [Architecture](./ARCHITECTURE.md) — System design

<a id="api-reference"></a>

## API & Commands
- [Getting Started](./GETTING-STARTED.md) — First steps
- [API Reference](./API-REFERENCE.md) — HTTP/Gateway endpoints
- [Quickstart](./QUICKSTART.md) — Single quickstart guide
- [Operations Manual](./OPERATIONS-MANUAL.md) — Ops runbook
- [Debug Commands](./DEBUG-COMMANDS.md) — `memphis debug` usage
- [CLI Command Matrix](./CLI-COMMAND-MATRIX.md) — command group map
- [Performance Tuning](./PERFORMANCE-TUNING.md) — latency/throughput tuning

## Community
- [GitHub](https://github.com/Memphis-Chains/memphis-v5)
- [Discord](https://discord.com/invite/clawd)
- [Issues](https://github.com/Memphis-Chains/memphis-v5/issues)

## Quick Start

```bash
# Install
git clone https://github.com/Memphis-Chains/memphis-v5.git
cd memphis && npm install && npm run build && npm link

# Setup
memphis setup
memphis doctor

# Test
memphis ask --input "What is Memphis?"
```

## Helper Scripts

```bash
./scripts/install-prerequisites.sh  # Install system deps
./scripts/verify-installation.sh    # Verify installation
./scripts/test-installation.sh      # Run smoke tests
```

<a id="troubleshooting"></a>

## Documentation Structure

```text
docs/
├── README.md (INDEX)
├── Installation/
│   ├── PREREQUISITES.md
│   ├── INSTALLATION.md
│   ├── OLLAMA-SETUP.md
│   ├── POST-INSTALLATION.md
│   └── RE-INSTALL.md
├── Configuration/
│   ├── CONFIGURATION.md
│   └── QUICK-START-SCENARIOS.md
├── Testing/
│   ├── TESTING-VERIFICATION.md
│   └── TROUBLESHOOTING*.md
└── Integration/
    ├── OPENCLAW-INTEGRATION.md
    └── ARCHITECTURE.md
```

## Version
- Current: v0.2.0-beta.1
- Status: Production Ready
