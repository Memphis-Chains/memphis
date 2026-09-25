# halt-aware-destructive-ops

**Skill version:** 0.1.0
**Tier:** 0 (no vault, no passphrase)
**Pattern type:** pre-flight guard + cron integrity + audit log (combo)
**Audience:** all Memphis agents (memphis-tui, minimax-code, future peers)

## Purpose

Prevent unintended destructive operations on files explicitly marked HALT (e.g. awaiting peer council, awaiting operator decision, in-flight review). Halt list lives in `~/.memphis/halt/` as one file per halted resource.

## When to use

Invoke `check.sh` BEFORE any of these operations:
- `rm` (file deletion)
- `rm -rf` (recursive deletion)
- `mv` (move/rename)
- `git rm` (tracked-file removal)
- `gio trash` (Trash-can deletion)
- `unlink` (low-level)
- any wrapper script that performs the above

Or install the bash hook in `~/.bashrc` for automatic guarding.

## Components

| Component | Path | Purpose |
|---|---|---|
| Skill scripts | `~/memphis/skills/halt-aware-destructive-ops/` | `check.sh`, `register.sh`, `unregister.sh`, `audit.sh`, `verify.sh` |
| HALT registry | `~/.memphis/halt/` | one file per halted resource; filename = sha256(resourcePath) prefix |
| Audit log (JSONL) | `~/.memphis/audit/halt/events.jsonl` | append-only log of every check (pass/block/bypass) and verify run; moved out of `chains/` per postmortem 2026-09-22 (action A1) |
| Bash hook | `~/.bashrc` (`halt_guard` function) | auto-guard via DEBUG trap preexec |
| Cron integrity | `memphis-halt-integrity.{timer,service}` | daily 09:00 verify HALT files exist |

## HALT registry file format

Each file in `~/.memphis/halt/` is a JSON document:

```json
{
  "resourcePath": "scripts/ci-workflow-install-step-lint.mjs",
  "haltedAt": "2026-09-21T23:51:08Z",
  "haltedBy": "collective/000025",
  "reason": "awaiting peer council response",
  "expiresAt": null,
  "registeredBy": "agent-id",
  "verifyCommand": "git status scripts/"
}
```

- `resourcePath` — full path from `~/` (e.g. `memphis/scripts/...` or `.memphis/...`)
- `haltedBy` — chain reference (`collective/NNNNN`, `decisions/NNNNN`, etc.)
- `reason` — human-readable reason (appears in pre-flight output)
- `expiresAt` — ISO timestamp or null (forever)
- `verifyCommand` — optional command to confirm file integrity during scheduled check

## check.sh (pre-flight guard)

```bash
#!/usr/bin/env bash
# halt-aware-destructive-ops/check.sh
# Check whether any argument matches a halted resource.
# Exit 0 = safe to proceed. Exit 1 = blocked. Exit 2 = bypass required.
#
# Usage:
#   ./check.sh /path/to/file
#   ./check.sh scripts/ci-workflow-install-step-lint.mjs
#   HALT_BYPASS=1 ./check.sh scripts/ci-workflow-install-step-lint.mjs
#   HALT_BYPASS_REASON="council-approved" ./check.sh ...
#
# Reads:
#   ~/.memphis/halt/*.json
# Appends:
#   ~/.memphis/audit/halt/events.jsonl (one JSON object per line)
#
# Audit storage moved out of chains/ on 2026-09-22 (postmortem
# docs/postmortems/2026-09-22-chains-halt-invalid-block-shape.md, action A1).
# Writing under chains/ would create non-conforming chain blocks (no
# prev_hash/hash) and crash memphis at next BOOT. JSONL append-only is
# the correct shape for an audit log.

set -euo pipefail

HALT_DIR="${MEMPHIS_HOME:-$HOME/.memphis}/halt"
AUDIT_DIR="${MEMPHIS_HOME:-$HOME/.memphis}/audit/halt"
AUDIT_FILE="$AUDIT_DIR/events.jsonl"

if [ $# -eq 0 ]; then
    echo "Usage: $0 <path> [path...]" >&2
    exit 64  # EX_USAGE
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq not installed (apt install jq)" >&2
    exit 127
fi

mkdir -p "$AUDIT_DIR"

# Monotonic event index, computed from existing JSONL line count.
new_index=$(wc -l < "$AUDIT_FILE" 2>/dev/null || echo 0)
new_index=$((new_index + 1))

# Iterate HALT list
result="pass"
matches=()
if [ -d "$HALT_DIR" ]; then
    for halt_file in "$HALT_DIR"/*.json; do
        [ -e "$halt_file" ] || continue
        halted_resource=$(jq -r '.resourcePath // empty' "$halt_file" 2>/dev/null || true)
        [ -z "$halted_resource" ] && continue
        halted_by=$(jq -r '.haltedBy // "unknown"' "$halt_file" 2>/dev/null || true)
        reason=$(jq -r '.reason // "no reason given"' "$halt_file" 2>/dev/null || true)

        for arg in "$@"; do
            # Match by basename OR by full path
            arg_base=$(basename "$arg")
            halt_base=$(basename "$halted_resource")
            if [ "$arg" = "$halted_resource" ] || [ "$arg_base" = "$halt_base" ]; then
                matches+=("$halted_resource|$halted_by|$reason")
                result="block"
            fi
        done
    done
fi

# Handle bypass
if [ "$result" = "block" ] && [ "${HALT_BYPASS:-0}" != "1" ]; then
    echo "HALT GUARD BLOCKED" >&2
    echo "  Matched halted resource(s):" >&2
    for m in "${matches[@]}"; do
        IFS='|' read -r res by reason <<< "$m"
        echo "    - $res" >&2
        echo "      halted-by: $by" >&2
        echo "      reason:    $reason" >&2
    done
    echo "  To proceed consciously, set HALT_BYPASS=1 + HALT_BYPASS_REASON='...'" >&2
    audit_action="block"
    audit_result=1
elif [ "$result" = "block" ]; then
    echo "HALT GUARD BYPASSED with HALT_BYPASS_REASON='${HALT_BYPASS_REASON:-unset}'" >&2
    echo "  Matched: ${matches[*]}" >&2
    audit_action="bypass"
    audit_result=0
else
    audit_action="pass"
    audit_result=0
fi

# Build audit line safely (jq -nc for compact one-line JSON)
args_json=$(printf '%s\n' "$@" | jq -R . | jq -s 'map(select(length > 0))')
matches_json=$(printf '%s\n' "${matches[@]:-}" | jq -R . | jq -s 'map(select(length > 0))')

jq -nc \
    --argjson index "$new_index" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg action "$audit_action" \
    --argjson args "$args_json" \
    --argjson matches "$matches_json" \
    --arg bypass_reason "${HALT_BYPASS_REASON:-}" \
    --arg caller "${USER:-unknown}@$(hostname 2>/dev/null || echo unknown)" \
    '{
        kind: "halt-check",
        index: $index,
        timestamp: $timestamp,
        action: $action,
        args: $args,
        matches: $matches,
        bypass_reason: $bypass_reason,
        caller: $caller
    }' >> "$AUDIT_FILE"

exit $audit_result
```

## register.sh

```bash
#!/usr/bin/env bash
# halt-aware-destructive-ops/register.sh
# Register a resource as HALT.
#
# Usage:
#   ./register.sh <resource-path> <halted-by-chain-ref> <reason> [expires-at]
#   ./register.sh scripts/ci-workflow-install-step-lint.mjs collective/000025 "awaiting council"

set -euo pipefail

HALT_DIR="${MEMPHIS_HOME:-$HOME/.memphis}/halt"
mkdir -p "$HALT_DIR"

if [ $# -lt 3 ]; then
    echo "Usage: $0 <resource-path> <halted-by-chain-ref> <reason> [expires-at]" >&2
    exit 64
fi

resource_path="$1"
halted_by="$2"
reason="$3"
expires_at="${4:-null}"

# Use sha256 of resource_path as filename (deterministic, no path conflicts)
filename=$(echo -n "$resource_path" | sha256sum | cut -c1-16)
out="$HALT_DIR/$filename.json"

cat > "$out" <<EOF
{
  "resourcePath": "$resource_path",
  "haltedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "haltedBy": "$halted_by",
  "reason": "$reason",
  "expiresAt": $expires_at,
  "registeredBy": "${USER:-unknown}"
}
EOF

echo "Registered HALT: $resource_path"
echo "  File: $out"
echo "  Halted by: $halted_by"
echo "  Reason: $reason"
```

## unregister.sh

```bash
#!/usr/bin/env bash
# halt-aware-destructive-ops/unregister.sh
# Remove a HALT entry (requires conscious trigger).
#
# Usage:
#   ./unregister.sh <resource-path>
#   ./unregister.sh scripts/ci-workflow-install-step-lint.mjs

set -euo pipefail

HALT_DIR="${MEMPHIS_HOME:-$HOME/.memphis}/halt"

if [ $# -lt 1 ]; then
    echo "Usage: $0 <resource-path>" >&2
    exit 64
fi

resource_path="$1"
filename=$(echo -n "$resource_path" | sha256sum | cut -c1-16)
target="$HALT_DIR/$filename.json"

if [ ! -e "$target" ]; then
    echo "No HALT entry for: $resource_path" >&2
    echo "Files in $HALT_DIR:" >&2
    ls -la "$HALT_DIR" 2>&1 | head >&2
    exit 1
fi

cat "$target"
echo "---"
read -p "Confirm unregister? (type 'yes' to proceed): " confirm
if [ "$confirm" != "yes" ]; then
    echo "Aborted."
    exit 1
fi

rm "$target"
echo "Removed HALT: $resource_path"
```

## verify.sh (cron-time integrity check)

```bash
#!/usr/bin/env bash
# halt-aware-destructive-ops/verify.sh
# Scheduled integrity check — runs daily 09:00 via memphis-halt-integrity.timer.
#
# For each HALT file, verify:
#   - if expiresAt is null or future, resource still exists at resourcePath
#   - if verifyCommand is set, run it and report failure
#
# Exit 0 = all OK. Exit 1 = at least one violation.
#
# Audit storage moved out of chains/ on 2026-09-22 (postmortem
# docs/postmortems/2026-09-22-chains-halt-invalid-block-shape.md, action A1).

set -uo pipefail

HALT_DIR="${MEMPHIS_HOME:-$HOME/.memphis}/halt"
AUDIT_DIR="${MEMPHIS_HOME:-$HOME/.memphis}/audit/halt"
AUDIT_FILE="$AUDIT_DIR/events.jsonl"

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq not installed (apt install jq)" >&2
    exit 127
fi

mkdir -p "$AUDIT_DIR"
new_index=$(wc -l < "$AUDIT_FILE" 2>/dev/null || echo 0)
new_index=$((new_index + 1))

violations=0
report_lines=()

if [ -d "$HALT_DIR" ]; then
    for halt_file in "$HALT_DIR"/*.json; do
        [ -e "$halt_file" ] || continue
        resource_path=$(jq -r '.resourcePath // empty' "$halt_file" 2>/dev/null || true)
        halted_by=$(jq -r '.haltedBy // "unknown"' "$halt_file" 2>/dev/null || true)
        expires_at=$(jq -r '.expiresAt // empty' "$halt_file" 2>/dev/null || true)
        verify_cmd=$(jq -r '.verifyCommand // empty' "$halt_file" 2>/dev/null || true)

        [ -z "$resource_path" ] && continue

        # Check expiry
        if [ -n "$expires_at" ] && [ "$expires_at" != "null" ]; then
            exp_epoch=$(date -d "$expires_at" +%s 2>/dev/null || echo 0)
            now_epoch=$(date +%s)
            if [ "$exp_epoch" -gt 0 ] && [ "$now_epoch" -gt "$exp_epoch" ]; then
                report_lines+=("EXPIRED: $resource_path (was halted by $halted_by)")
                continue
            fi
        fi

        # Resolve full path (resourcePath is relative to ~)
        full_path="$HOME/$resource_path"
        if [ ! -e "$full_path" ]; then
            report_lines+=("MISSING: $resource_path (halted by $halted_by, file no longer exists)")
            violations=$((violations + 1))
            continue
        fi

        # Optional verify command
        if [ -n "$verify_cmd" ]; then
            if ! bash -c "cd $HOME/memphis && $verify_cmd" >/dev/null 2>&1; then
                report_lines+=("VERIFY FAILED: $resource_path (cmd: $verify_cmd)")
                violations=$((violations + 1))
                continue
            fi
        fi

        report_lines+=("OK: $resource_path")
    done
fi

# Build audit line safely (jq -c for compact one-line JSON)
report_json=$(printf '%s\n' "${report_lines[@]}" | jq -R . | jq -s 'map(select(length > 0))')
jq -nc \
    --argjson index "$new_index" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson violations "$violations" \
    --argjson report "$report_json" \
    '{
        kind: "halt-verify",
        index: $index,
        timestamp: $timestamp,
        action: "verify",
        violations: $violations,
        report: $report
    }' >> "$AUDIT_FILE"

if [ "$violations" -gt 0 ]; then
    echo "halt-verify: $violations violation(s) found"
    printf '  %s\n' "${report_lines[@]}"
    exit 1
fi

echo "halt-verify: OK (${#report_lines[@]} resources checked)"
exit 0
```

## audit.sh (read JSONL log)

```bash
#!/usr/bin/env bash
# halt-aware-destructive-ops/audit.sh
# Read halt audit JSONL and display recent activity.
#
# Usage:
#   ./audit.sh [last-N]   (default N=10)
#
# Reads:
#   ~/.memphis/audit/halt/events.jsonl (JSONL, one JSON object per line)
#
# Audit storage moved out of chains/ on 2026-09-22 (postmortem
# docs/postmortems/2026-09-22-chains-halt-invalid-block-shape.md, action A1).

set -euo pipefail

AUDIT_DIR="${MEMPHIS_HOME:-$HOME/.memphis}/audit/halt"
AUDIT_FILE="$AUDIT_DIR/events.jsonl"
last_n="${1:-10}"

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq not installed" >&2
    exit 127
fi

if [ ! -f "$AUDIT_FILE" ]; then
    echo "No audit log yet. Run check.sh or verify.sh to populate."
    exit 0
fi

echo "halt audit log (last $last_n entries):"
tail -n "$last_n" "$AUDIT_FILE" | jq -C '{
    index: .index,
    timestamp: .timestamp,
    kind: .kind,
    action: .action,
    args: .args,
    matches: .matches,
    violations: .violations
}' 2>&1 || echo "(jq parse failed on one or more lines)"
```

## Bash hook (auto-guard)

Add to `~/.bashrc` or per-agent config:

```bash
# halt-aware-destructive-ops: auto-guard destructive operations
halt_guard() {
    local cmd="$1"; shift
    case "$cmd" in
        rm|mv|unlink|gio|git)
            # check arguments against halt list
            if [ -x "$HOME/memphis/skills/halt-aware-destructive-ops/check.sh" ]; then
                "$HOME/memphis/skills/halt-aware-destructive-ops/check.sh" "$@"
                return $?
            fi
            ;;
    esac
    return 0
}

# Install as DEBUG trap (runs before each command)
trap 'halt_guard ${BASH_COMMAND%% *}' DEBUG 2>/dev/null || true
```

## Cron integration (systemd user timer)

`~/.config/systemd/user/memphis-halt-integrity.timer`:

```ini
[Unit]
Description=Daily halt-aware integrity check (09:00)

[Timer]
OnCalendar=*-*-* 09:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

`~/.config/systemd/user/memphis-halt-integrity.service`:

```ini
[Unit]
Description=Halt-aware integrity verification

[Service]
Type=oneshot
ExecStart=/home/memphis/memphis/skills/halt-aware-destructive-ops/verify.sh
StandardOutput=append:/home/memphis/.memphis/logs/halt-verify.log
StandardError=append:/home/memphis/.memphis/logs/halt-verify.log
```

Enable:
```bash
systemctl --user daemon-reload
systemctl --user enable --now memphis-halt-integrity.timer
```

## Tests

Manual smoke test:
```bash
# Register a test halt
~/memphis/skills/halt-aware-destructive-ops/register.sh \
    scripts/ci-workflow-install-step-lint.mjs \
    collective/000025 \
    "awaiting peer council"

# Try to delete — should be blocked
rm scripts/ci-workflow-install-step-lint.mjs
# (or via the skill: ./check.sh scripts/ci-workflow-install-step-lint.mjs)

# Bypass consciously
HALT_BYPASS=1 HALT_BYPASS_REASON="council-approved" \
    rm scripts/ci-workflow-install-step-lint.mjs

# Inspect audit
~/memphis/skills/halt-aware-destructive-ops/audit.sh 5

# Unregister
~/memphis/skills/halt-aware-destructive-ops/unregister.sh \
    scripts/ci-workflow-install-step-lint.mjs

# Verify (cron mode)
~/memphis/skills/halt-aware-destructive-ops/verify.sh
```

## Limitations

- Skill relies on `jq` being available (standard on Ubuntu/Debian)
- Bash hook only fires for interactive shells, not for shell scripts run via `bash -c`
- For non-bash agents, the skill must be invoked explicitly (no automatic guard)
- `gio trash` deletion paths may differ across desktop environments

## Out of scope

- Preventing HALT files themselves from being deleted (security boundary)
- Distributed halt-list across federation nodes (single-host only)
- Tier-2 passphrase-gated halt override (HALT_BYPASS is plain env var)
- Auto-detection of "this should be halted" (only manual registration)

## Provenance

Created 2026-09-22 in response to incident where `scripts/ci-workflow-install-step-lint.mjs` was deleted by minimax-code (peer agent) while collective #25 council-request HALT was active. Operator requested pattern implementation with combo (skill + cron).

See decisions #227 (initial mis-attribution) and #228 (correction + pattern proposal).
