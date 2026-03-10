# Memphis v4

Memphis v4 is a local-first assistant runtime for building and operating AI task workflows.

**👉 [Simple Install Guide](docs/SIMPLE-INSTALL.md) — One command setup**

---

## What users can do

- Run assistant workflows from CLI/TUI
- Use built-in health/provider/doctor checks
- Execute quality and smoke gates before changes
- Use external-proof ops flow (readiness → pack → validate → ledger)

---

## Quick Start (One-Liner)

```bash
git clone https://github.com/Memphis-Chains/memphis-v4.git && \
cd memphis-v4 && \
./scripts/install.sh && \
sed -i "/^MEMPHIS_VAULT_PEPPER=$/c\MEMPHIS_VAULT_PEPPER=$(openssl rand -hex 32)" .env && \
npm run -s cli -- doctor
```

If doctor shows `"ok": true`, you're ready!

**Why Rust?** Memphis uses native crypto (Argon2id + AES-256-GCM) for vault encryption. See [Simple Install Guide](docs/SIMPLE-INSTALL.md#why-rust).

Quick verification:

```bash
npm run -s cli -- doctor --json
npm run -s cli -- health --json
npm run -s cli -- ask --input "Hello Memphis" --provider local-fallback
```

Optional TUI:

```bash
npm run -s cli -- tui
```

### Shell completions (bash/zsh/fish)

Generate completion scripts to stdout:

```bash
memphis-v4 completion bash
memphis-v4 completion zsh
memphis-v4 completion fish
```

Install examples:

```bash
# bash (current shell)
source <(memphis-v4 completion bash)

# zsh (current shell)
source <(memphis-v4 completion zsh)

# fish (persistent)
memphis-v4 completion fish > ~/.config/fish/completions/memphis-v4.fish
```

If your binary is named `memphis`, the same command works:

```bash
source <(memphis completion bash)
```

---

## Useful commands

```bash
# health and diagnostics
npm run -s cli -- doctor --json
npm run -s cli -- health --json
npm run -s cli -- providers:health --json
npm run -s cli -- providers list --json
npm run -s cli -- models list --json

# run core closure checks
npm run -s ops:native-closure-check
npm run -s ops:phase8-ledger-status

# package verification
npm run -s pack:dry-run
```

---

## Install & docs

- User quickstart: `docs/USER-QUICKSTART-GITHUB.md`
- Onboarding details: `docs/ONBOARDING-INSTALL.md`
- Release process: `docs/RELEASE-PROCESS.md`
- Package publish/install: `docs/PACKAGE-PUBLISH.md`
- Package/release status snapshot: `docs/PUBLISH-STATUS.md`
- Full process history: `docs/PROCESS-HISTORY-2026-03.md`
- Full docs index: `docs/`

---

## Releases

Latest release notes are in GitHub Releases and `docs/releases/`.

---

## Operator/internal notes

Production operator context moved to:
- `docs/PRODUCTION-OPERATOR-NOTES.md`
