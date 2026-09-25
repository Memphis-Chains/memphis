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
