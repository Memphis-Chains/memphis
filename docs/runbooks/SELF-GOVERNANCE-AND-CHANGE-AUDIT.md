# Self-Governance And Change Audit

Use this runbook when an operator asks:

- "Can Memphis steer itself?"
- "Can Memphis modify its own code?"
- "Did the code change?"
- "Is this a fresh runtime fact or an old snapshot?"

## Governance Truth

Canonical CLI command:

```bash
memphis self-governance status --json
```

Canonical MCP/in-process tool:

```json
{"name":"memphis_self_governance_status","arguments":{}}
```

Use `memphis tools list --json` when you need to confirm the capability surface is reachable before calling the tool.

Interpretation:

- `capable=true`: runtime has no current blockers for supervised self-governance.
- `canSelfRecover=true`: runtime has enough health, fallback, chain integrity, and backup posture to recover under supervision.
- `canSelfModify=false`: code modification is blocked unless the supervised self-modify workflow is explicitly invoked and approved.
- `blockingReasons`: must be quoted as the current reason. Do not replace this with memory or an older snapshot.
- `recommendedActions`: next operator-facing actions.

## Self-Modify Contract

Self-modification is supervised, not autonomous. A valid self-modify attempt requires:

- explicit operator intent
- a concrete plan
- fresh dirty-tree audit
- backup/snapshot before writes
- branch isolation
- focused test gate
- operator approval before merge or public push
- rollback path on gate failure

`canSelfModify:false` is a real blocker. It is not cosmetic and must not be bypassed by direct file writes, shell commands, or claims that a change is "small".

## Code Change Audit

Answer "did code change?" from fresh commands only:

```bash
git status --short
git diff --stat
git diff --name-status
git diff --cached --name-status
git log --oneline -5
```

Then inspect runtime/system audit events where relevant:

```bash
memphis audit search --action self --limit 20 --json
memphis backup list --json
```

Classification:

- Git worktree changes: code or repo artifact changes.
- Backup archives under `~/.memphis/backups`: runtime/data snapshots, not code commits.
- Chain blocks under `~/.memphis/chains`: runtime memory, not source code.
- Files under `vault/**`, PSA notes/data, lead files, generated dashboards: private-local unless explicitly approved for publication.

## Fresh Runtime Gate

Before saying "all green" or "fully ready", run:

```bash
memphis health --json
memphis readiness --json
memphis self-governance status --json
memphis tensor status --json
memphis tools list --json
memphis embed search --query test --json
memphis chain verify --chain journal
memphis backup list --json
systemctl --user status memphis.service
```

Required distinction:

- `health` OK means alive plus core healthy.
- `readiness` OK means usable end-to-end for operator workflows.
- `self-governance` OK means supervised autonomy has no current blockers.

## Vault Integrity Startup Blocker

If `systemctl --user restart memphis.service` fails with `Vault integrity probe failed — refusing to start`, do not wipe vault data as a default repair. First create a fresh backup, then prefer a temporary user-service bypass so the daemon can stay alive while `readiness` continues to report the vault blocker:

```bash
memphis backup create --tag pre-vault-integrity-work
systemctl --user set-environment MEMPHIS_SKIP_VAULT_INTEGRITY_PROBE=true
systemctl --user restart memphis.service
```

This is not a full readiness fix. Full readiness still requires repairing or re-adding the missing vault secrets and then removing the bypass before the next normal restart.

If a vault diagnostic reports:

```text
Failed to load vault state from /home/memphis/.memphis/vault-state.json. Check MEMPHIS_VAULT_PEPPER matches the state.
```

then the current `.env` pepper does not unwrap the live vault state. Non-destructive recovery requires the matching old pepper or the configured recovery answer. Destructive recovery requires moving the current vault files aside, re-initializing the vault, and re-adding provider/channel secrets from external secure storage.
