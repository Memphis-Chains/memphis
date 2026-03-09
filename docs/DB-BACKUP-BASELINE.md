# DB + Backup Baseline Policy

## Database baseline
- Primary runtime DB: `DATABASE_URL` (SQLite path in current profile).
- Production requirement: DB path must be persistent storage (not `/tmp`).
- Recommended format: `file:/absolute/path/to/memphis-v4-prod.db`.

## Backup baseline
- Minimum cadence: daily snapshot.
- Retention baseline: 7 daily + 4 weekly backups.
- Verify restore path at least once per sprint.

## Scope to back up
- SQLite DB file (`DATABASE_URL` target)
- Vault entries file (`MEMPHIS_VAULT_ENTRIES_PATH`)
- Runtime state required for incident forensics (`~/.memphis/state` optional but recommended)

## Restore checklist (minimum)
1. Stop write-heavy runtime processes.
2. Restore DB + vault entries from same recovery point.
3. Run smoke: `npm run smoke:ollama-runtime`.
4. Run vault runtime E2E if vault path is enabled.
5. Validate `/health` and `/v1/ops/status`.

## Non-goals
- This baseline does not define off-site encryption/rotation implementation details.
- Team-specific infra backup tooling can extend this policy.
