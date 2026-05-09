#!/usr/bin/env bash
#
# Memphis stability watcher — closure sprint Z.7 (2026-05-09)
#
# Run every 15 minutes via cron OR `memphis schedule add` to surface
# silent regressions in operator's daily-use environment. Each invocation:
#   1. Probes `memphis doctor --json` and asserts `summary.ok === true`.
#   2. Probes `curl -sf localhost:8080/v1/ops/status` (HTTP daemon).
#   3. On any non-zero, writes a JSON incident record to
#      `${MEMPHIS_HOME:-~/.memphis}/stability-incidents/<ts>.json`.
#   4. Always continues (per `feedback_observable_not_nanny`); a single
#      failed probe must not crash the watcher because the next probe
#      may catch a transient flap.
#
# Cron suggestion (operator's user crontab):
#   */15 * * * * /home/memphis/memphis/crons/health-watch.sh >> ~/.memphis/logs/health-watch.log 2>&1
#
# OR via `memphis schedule add`:
#   memphis schedule add --cron "*/15 * * * *" \
#     --name "Z.7 stability watch" \
#     --type shell --script /home/memphis/memphis/crons/health-watch.sh
#

set -uo pipefail

readonly MEMPHIS_DIR="${MEMPHIS_HOME:-$HOME/.memphis}"
readonly INCIDENTS_DIR="$MEMPHIS_DIR/stability-incidents"
readonly RUNS_DIR="$MEMPHIS_DIR/stability-runs"
readonly TS=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$INCIDENTS_DIR" "$RUNS_DIR"

# 1. doctor probe — `ok` lives at the top-level of the report
# (computed as `summary.requiredFailures === 0`), not nested in summary
DOCTOR_JSON=$(memphis doctor --json 2>/dev/null || echo '{"ok":false,"_probe_error":"memphis doctor exit non-zero"}')
DOCTOR_OK=$(echo "$DOCTOR_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print('true' if d.get('ok') else 'false')" 2>/dev/null || echo false)

# 2. HTTP probe — Memphis HTTP daemon defaults to PORT=3100; operator
# can override via MEMPHIS_HTTP_PORT env. The probe port matches what
# `memphis service status` reports.
#
# We drop -f (which makes curl exit non-zero on >=400) so that a 401
# Unauthorized — the EXPECTED response from `/v1/ops/status` without
# bearer token — counts as "daemon is alive and rejecting unauth
# requests as designed". Treat 200, 401, 403 as healthy ("daemon
# responded"); anything else (connection refused → curl exit, 500,
# 502, 503, 504) → unhealthy.
HTTP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:${MEMPHIS_HTTP_PORT:-3100}/v1/ops/status" 2>/dev/null || echo "fetch-failed")
case "$HTTP_STATUS" in
  200|401|403) HTTP_HEALTHY=true ;;
  *)           HTTP_HEALTHY=false ;;
esac

# 3. process-lock probe
PID_FILE="$MEMPHIS_DIR/memphis.pid"
DAEMON_PID=$(cat "$PID_FILE" 2>/dev/null || echo "no-pid-file")
DAEMON_ALIVE="false"
if [[ "$DAEMON_PID" =~ ^[0-9]+$ ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
  DAEMON_ALIVE="true"
fi

# Record run summary (always, success or fail). `doctor_ok`,
# `daemon_alive`, and `http_healthy` are emitted as proper JSON
# `true`/`false` literals (lowercase) so downstream consumers can
# `jq '.doctor_ok'` cleanly.
echo "{\"ts\":\"$TS\",\"doctor_ok\":$DOCTOR_OK,\"http_status\":\"$HTTP_STATUS\",\"http_healthy\":$HTTP_HEALTHY,\"daemon_pid\":\"$DAEMON_PID\",\"daemon_alive\":$DAEMON_ALIVE}" > "$RUNS_DIR/$TS.json"

# Record incident if any probe failed
if [[ "$DOCTOR_OK" != "true" ]] || [[ "$HTTP_HEALTHY" != "true" ]] || [[ "$DAEMON_ALIVE" != "true" ]]; then
  cat > "$INCIDENTS_DIR/$TS.json" <<EOF
{
  "ts": "$TS",
  "doctor_ok": $DOCTOR_OK,
  "http_status": "$HTTP_STATUS",
  "http_healthy": $HTTP_HEALTHY,
  "daemon_pid": "$DAEMON_PID",
  "daemon_alive": $DAEMON_ALIVE,
  "doctor_payload": $DOCTOR_JSON
}
EOF
  echo "[health-watch] incident recorded at $INCIDENTS_DIR/$TS.json (doctor_ok=$DOCTOR_OK, http_status=$HTTP_STATUS, http_healthy=$HTTP_HEALTHY, daemon_alive=$DAEMON_ALIVE)" >&2
fi

# Always exit 0 — the watcher itself must never fail; incidents are
# read by post-hoc audit (e.g. `ls -la ~/.memphis/stability-incidents/`)
exit 0
