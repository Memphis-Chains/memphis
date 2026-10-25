#!/usr/bin/env bash
# Compact runtime summary for the Omarchy quickshell plugin.
# Writes one JSON object to stdout. Never blocks longer than the timeout:
# the panel refreshes on a timer, so a slow answer is worse than none.
# Degrades to {ok:false} instead of failing, so a broken runtime shows as a
# stale panel rather than an empty bar slot.
set -uo pipefail

ROOT="/home/memphis/memphis"
TIMEOUT_S="${MEMPHIS_HEALTH_TIMEOUT_S:-8}"

RAW="$(cd "$ROOT" && timeout "$TIMEOUT_S" node bin/memphis.js health --json 2>/dev/null)"

if [ -z "$RAW" ]; then
  jq -nc '{ok:false, reason:"timeout-or-empty"}'
  exit 0
fi

printf '%s' "$RAW" | jq -c '
  def n(x): (x // 0) | tonumber? // 0;
  {
    ok: true,
    status: (.runtimeStatus // "unknown"),
    version: (.version // ""),
    provider: (.defaultProvider // ""),
    repairable: (.repairable // false),
    recommendedAction: (.recommendedAction // "none"),
    blocks: n(.runtime.chainMemory.totalBlocks),
    chains: ((.runtime.chainMemory.activeChains // []) | length),
    integrityChecked: n(.runtime.chainMemory.integrity.checked),
    integrityInvalid: n(.runtime.chainMemory.integrity.invalid),
    recallMode: (.runtime.memory.recallMode // ""),
    topChains: (
      (.runtime.chainMemory.counts // {})
      | to_entries | map(select(.value > 0))
      | sort_by(-.value) | map({key: .key, value: .value}) | .[0:5]
    )
  }
'
