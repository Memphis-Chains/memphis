# Memphis v4

Memphis v4 is a local-first assistant runtime for building and operating AI task workflows.

If you want to install quickly and start using it, begin here:
- `docs/USER-QUICKSTART-GITHUB.md`

---

## What users can do

- Run assistant workflows from CLI/TUI
- Use built-in health/provider/doctor checks
- Execute quality and smoke gates before changes
- Use external-proof ops flow (readiness → pack → validate → ledger)

---

## 5-minute quick start

```bash
git clone https://github.com/Memphis-Chains/memphis-v4.git
cd memphis-v4
./scripts/install.sh
npm run build
```

Set minimum required `.env` values (if not already set by your profile):

```dotenv
DEFAULT_PROVIDER=local-fallback
DATABASE_URL=file:./data/memphis-v4.db
MEMPHIS_VAULT_PEPPER=memphis-dev-pepper-2026
LOCAL_FALLBACK_ENABLED=true
```

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

---

## Useful commands

```bash
# health and diagnostics
npm run -s cli -- doctor --json
npm run -s cli -- health --json
npm run -s cli -- providers:health --json

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
