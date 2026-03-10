# Migration Guide: v3 → v4

## Overview

### What changed

Memphis v4 introduces a stricter, production-oriented runtime with:

- A unified `memphis-v4` CLI surface (health, doctor, onboarding, chain/vault/embed tools)
- Safer chain import semantics (`chain import_json`) with dry-run first and explicit write confirmation
- Stronger configuration expectations via `.env` + required doctor checks
- Expanded HTTP/API surface for ops, vault, and session workflows

### Why migrate

- Better operational safety (doctor checks, explicit write guards)
- More predictable runtime behavior in production
- Built-in migration-safe chain normalization for legacy JSON structures
- Improved diagnostics (`doctor`, `health`, `providers:health`) and onboarding helpers

### Breaking changes summary

- CLI command set is reorganized (several v3 commands renamed/removed)
- Runtime configuration has required `.env` keys in v4 (`MEMPHIS_VAULT_PEPPER`, `DATABASE_URL`, `DEFAULT_PROVIDER`)
- API endpoints are now versioned under `/v1/*` for most features
- Chain data import is explicit and guarded (dry-run by default, `--write --confirm-write` required)

---

## Prerequisites

### Requirements

- Node.js 20+
- npm
- (Recommended) Rust toolchain 1.70+ for native components
- Access to your old v3 chain files (JSON)

### Backup recommendations

Before migrating:

1. Backup your v3 home directory (or at least `chains/` and config):
   ```bash
   cp -a ~/.memphis ~/.memphis.backup.$(date +%Y%m%d-%H%M%S)
   ```
2. Backup any existing v4 data if re-running migration:
   ```bash
   cp -a ./data ./data.backup.$(date +%Y%m%d-%H%M%S)
   ```
3. Keep backups until post-migration verification is complete.

---

## Step-by-step migration

### 1) Export v3 data

You can do this manually (copy JSON files) or with helper script.

**Helper script (recommended):**
```bash
cd /home/memphis_ai_brain_on_chain/memphis-v4
scripts/migrate-from-v3.sh
```

By default this script:

- Detects legacy v3 installation (if `memphis` exists)
- Locates legacy chains directory (`~/.memphis/chains` and common alternatives)
- Exports raw v3 JSON chain files
- Converts them to v4-compatible canonical format via `chain import_json`

Useful options:

```bash
scripts/migrate-from-v3.sh --help
scripts/migrate-from-v3.sh --chains-dir /path/to/v3/chains
scripts/migrate-from-v3.sh --skip-convert
```

---

### 2) Install v4

If not already installed:

```bash
git clone https://github.com/Memphis-Chains/memphis-v4.git
cd memphis-v4
./scripts/install.sh
npm run build
```

Create `.env` from template if needed:

```bash
cp .env.example .env
```

Set minimum required values:

```dotenv
MEMPHIS_VAULT_PEPPER=<strong-secret>
DATABASE_URL=file:./data/memphis-v4.db
DEFAULT_PROVIDER=local-fallback
```

---

### 3) Import data into v4

If you used the helper script, converted files are written into:

- `data/migration-v3/converted/*.v4.json`

You can also run conversion/import manually for any legacy JSON:

```bash
npm run -s cli -- chain import_json --file /path/to/v3-chain.json --json
npm run -s cli -- chain import_json --file /path/to/v3-chain.json --write --confirm-write --out ./data/imported-chain.json --json
```

Notes:

- Input schema can be direct array, `{ "blocks": [...] }`, or legacy `{ "chain": [...] }`
- Importer rewrites index and `prev_hash` links into canonical v4 chain shape
- Write mode is transactional and creates `.bak` backup when overwriting target

---

### 4) Verify

Run baseline checks:

```bash
npm run -s cli -- doctor --json
npm run -s cli -- health --json
npm run -s cli -- providers:health --json
```

Expected outcomes:

- `doctor` returns `"ok": true`
- `health` returns `"status": "ok"`
- provider health output is present (even if some providers are unavailable)

---

### 5) Switch over

After verification:

1. Stop v3 services/processes using the same data path
2. Point your scripts/automation to `memphis-v4`
3. Keep v3 backup untouched for rollback window (recommended: 7–14 days)

---

## Breaking changes

### Command changes (v3 vs v4)

| Legacy v3 command (typical) | v4 equivalent | Notes |
|---|---|---|
| `memphis init` | `memphis-v4 onboarding wizard --write --profile dev-local --out .env --force` (setup) + `doctor` | v4 uses profile-driven env onboarding and validation |
| `memphis journal "..."` | `memphis-v4 chain import_json --file <json>` or app-level writes | No direct `journal` command in current v4 CLI |
| `memphis ask "..."` | `memphis-v4 ask --input "..." [--provider ...]` | `--input` flag is required |
| `memphis status` | `memphis-v4 health --json` and `memphis-v4 providers:health --json` | Status split into focused health commands |
| `memphis provider list/test/add/remove` | `memphis-v4 providers list` / `models list` | Provider management is simplified/standardized |
| `memphis verify` | `memphis-v4 chain import_json` report + smoke/doctor checks | Chain integrity is handled through import normalization + checks |
| `memphis gateway start` | `memphis-v4 mcp serve` (for MCP transport) | Runtime transport model changed |

> If your v3 automation used custom wrappers/scripts, treat this table as mapping guidance and update scripts explicitly.

### Config changes (.env)

| v3 style (legacy) | v4 key | Action |
|---|---|---|
| legacy/optional config file (`config.yaml`, ad-hoc env) | `.env` file in repo/runtime path | Adopt `.env` as canonical runtime config |
| provider defaults in legacy profile | `DEFAULT_PROVIDER` | Must be set for clean doctor pass |
| local chain path conventions | `DATABASE_URL` | Set explicit storage backend/path |
| no required vault pepper in many setups | `MEMPHIS_VAULT_PEPPER` | Required for vault-enabled paths and doctor checks |
| optional provider URL/key naming | `SHARED_LLM_API_BASE`, `SHARED_LLM_API_KEY`, `DECENTRALIZED_LLM_*` | Rename and map to v4 keys |
| mixed embedding flags | `RUST_EMBED_*` keys | Keep only keys relevant to your selected embed mode |

### API changes

| Legacy v3 style (typical) | v4 endpoint | Notes |
|---|---|---|
| `GET /status` | `GET /v1/ops/status` | Ops status endpoint is versioned |
| `POST /chat` | `POST /v1/chat/generate` | Chat endpoint moved under `/v1` |
| `GET /providers/health` | `GET /v1/providers/health` | Versioned provider health |
| `GET /vault/*` (mixed) | `/v1/vault/init|encrypt|decrypt|entries` | Vault API is explicit and token-protected when configured |
| unversioned session events | `/v1/sessions`, `/v1/sessions/:sessionId/events` | Session API namespaced under `/v1` |

---

## Troubleshooting

### Common issues

1. **`doctor` fails: missing `.env` keys**
   - Fix:
     ```bash
     cp .env.example .env
     # fill required values: MEMPHIS_VAULT_PEPPER, DATABASE_URL, DEFAULT_PROVIDER
     ```

2. **Migration script cannot find v3 installation**
   - Pass explicit chain path:
     ```bash
     scripts/migrate-from-v3.sh --chains-dir /absolute/path/to/v3/chains
     ```

3. **Import fails for some chain files**
   - Re-run single file in dry-run JSON mode for details:
     ```bash
     npm run -s cli -- chain import_json --file <file> --json
     ```
   - Inspect `issues[]` and fix malformed blocks before write mode.

4. **Provider checks fail after migration**
   - Verify `DEFAULT_PROVIDER` and matching provider credentials in `.env`
   - Use local fallback for initial validation:
     ```bash
     DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- health --json
     ```

5. **`dist/` missing in doctor**
   - Build artifacts:
     ```bash
     npm run build
     ```

### Rollback procedure

If migration output is invalid or incomplete:

1. Stop v4 processes.
2. Restore v4 data backup (if overwritten):
   ```bash
   cp -a ./data.backup.<timestamp> ./data
   ```
3. If chain import overwrote a target with backup created by importer:
   ```bash
   cp <target>.bak <target>
   ```
4. Continue running v3 from original backup until issue is resolved:
   ```bash
   cp -a ~/.memphis.backup.<timestamp> ~/.memphis
   ```
5. Re-run migration in dry-run mode first, then write mode after report review.

---

## Data migration quick reference (chain files)

Accepted legacy JSON inputs for v4 import:

- `[{...}]`
- `{ "blocks": [{...}] }`
- `{ "chain": [{...}] }`

Field aliases supported during normalization:

- index: `index | idx | height`
- prev hash: `prev_hash | prevHash | previous_hash | previousHash`
- hash: `hash | block_hash`
- timestamp: `timestamp | ts | created_at`
- chain name: `chain | chain_name`
- content: `content | data.content | data.text`

This means most v3 chain exports can be imported directly without manual reformatting.
