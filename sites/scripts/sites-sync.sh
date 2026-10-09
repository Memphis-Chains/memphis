#!/usr/bin/env bash
# sites-sync.sh — two directions, never confused.
#
#   --pull <site>   production docroot  ->  sites/<site>/   (adopt what is live)
#   --push <site>   sites/<site>/       ->  production      (publish, gated)
#   --list          what exists on each side
#   --diff <site>   per-file comparison, no writes
#
# Pull is how a site enters the repo without losing anything: fetch the live
# docroot first, so the master is a byte copy of production, and only then start
# editing.
#
# Guards that make the transfer safe:
#   1. a partial transfer must never become the master — refuse when the fetch
#      returns fewer files than we already hold
#   2. the whole transfer is retried, because this host drops connections often
#      and rsync has no retry of its own
#   3. counting files must not abort the script — `find` on a missing directory
#      exits 1, and under `pipefail` that silently killed the first pull
#
# Push refuses when production moved since the last pull. That refusal is the
# whole point: a blind rsync from a stale mirror quietly reverts production to
# an old page, which is exactly what the old deploy.sh was one run away from.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITES_DIR="$(cd "$HERE/.." && pwd)"
ESTATE="$SITES_DIR/estate.json"
REPO_ROOT="${MEMPHIS_REPO:-$(cd "$HERE/../.." && pwd)}"
SSH_HOST="${SITES_SSH_HOST:-}"
SSH_CONFIG_FILE="${SITES_SSH_CONFIG:-}"
REMOTE_ROOT="public_html"

[[ -f "$ESTATE" ]] || { echo "[sites-sync] no estate.json at $ESTATE" >&2; exit 2; }
for tool in rsync python3; do
  command -v "$tool" >/dev/null || { echo "[sites-sync] $tool is required" >&2; exit 2; }
done

# ConnectTimeout=90, not 40. Measured on this host: a bare `echo` completes in
# under 40s but a `find` over the docroot times out at the same value. The
# timeout was reporting the command length, not the connection being down.
SSH_OPTS=(-o ConnectTimeout=90 -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o BatchMode=yes)
[[ -n "$SSH_CONFIG_FILE" ]] && SSH_OPTS=(-F "$SSH_CONFIG_FILE" "${SSH_OPTS[@]}")
RSYNC_SSH="ssh ${SSH_OPTS[*]}"

# `find` on a missing path exits 1. Under `set -euo pipefail` a bare
# `find ... | wc -l` therefore aborts the script with no message — the failure
# looks like success until you read the exit code. Always count through here.
count_files() { # <path>
  local p="$1" n
  if [[ ! -d "$p" ]]; then echo 0; return 0; fi
  n="$(find "$p" -type f 2>/dev/null | wc -l)" || n=0
  printf '%s\n' "${n:-0}"
}

MODE="list"; SITE=""
while (( $# )); do
  case "$1" in
    --pull|--push|--diff) MODE="${1#--}"; SITE="${2:-}"; shift 2 ;;
    --list) MODE="list"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ "$MODE" != "list" && -z "$SITE" ]] && { echo "usage: sites-sync.sh --{pull|push|diff} <site>" >&2; exit 2; }

field() { # <key> <field>
  python3 - "$ESTATE" "$1" "$2" <<'PY'
import json,sys
est, key, field = sys.argv[1], sys.argv[2], sys.argv[3]
d = next((x for x in json.load(open(est))["sites"] if x["key"] == key), None)
print(d.get(field, "") if d else "")
PY
}
known_site() { [[ -n "$(field "$SITE" dir)" ]] || { echo "[sites-sync] '$SITE' is not in estate.json" >&2; exit 2; }; }

# --list is purely local. Requiring SSH for it made an offline inspection
# impossible and hid the failure behind a misleading "set SITES_SSH_HOST".
require_ssh() {
  [[ -n "$SSH_HOST" ]] && return 0
  echo "[sites-sync] ${MODE} needs SITES_SSH_HOST (the web server alias)" >&2
  exit 2
}

remote_listing() { # -> "size<TAB>relpath", retried
  local out="" n=0
  require_ssh
  while (( n < 5 )); do
    n=$(( n + 1 ))
    set +e
    out="$(ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
            "cd $REMOTE_ROOT/$SITE && find . -type f -printf '%s\t%P\n' | sort -k2" </dev/null 2>/dev/null)"
    set -e
    [[ -n "$out" ]] && { printf '%s\n' "$out"; return 0; }
    sleep 6
  done
  echo "[sites-sync] cannot list $REMOTE_ROOT/$SITE after 5 attempts" >&2
  return 2
}

# rsync over a link that drops connections needs the transfer wrapped, not
# hoped for. Exit 255 is ssh's "connection closed" and is always safe to retry:
# rsync re-stats the destination each run, so a partial transfer resumes rather
# than duplicating. Only a non-255 code is treated as a real failure.
rsync_pull() { # <site> <dest>
  local site="$1" dest="$2" n=0 rc
  while (( n < 5 )); do
    n=$(( n + 1 ))
    set +e
    rsync -az -e "$RSYNC_SSH" \
      --exclude 'panel-app/' --exclude 'panel/' --exclude 'api/' --exclude 'data/' \
      --exclude '.memphis-snapshots/' \
      "$SSH_HOST:$REMOTE_ROOT/$site/" "$dest" >/dev/null 2>&1
    rc=$?
    set -e
    (( rc == 0 )) && return 0
    if (( rc == 255 )); then
      echo "    ssh dropped (255), attempt $n/5 — retrying"
      sleep 6
      continue
    fi
    echo "    rsync failed rc=$rc (not an ssh drop) — not retrying" >&2
    return "$rc"
  done
  echo "[sites-sync] transfer failed after 5 attempts" >&2
  return 2
}

case "$MODE" in
list)
  echo "registry (estate.json):"
  python3 - "$ESTATE" <<'PY'
import json,sys
for s in json.load(open(sys.argv[1]))["sites"]:
    print(f"  {s['key']:<14} {s['domain']:<28} {s['status']:<6} {s['dir']}")
PY
  echo
  echo "masters on disk under sites/:"
  found=0
  for d in "$SITES_DIR"/*/; do
    [[ -d "$d" ]] || continue
    k="$(basename "$d")"; [[ "$k" == scripts ]] && continue
    found=1
    printf '  %-14s %4s files\n' "$k" "$(count_files "$d")"
  done
  (( found )) || echo "  (none yet — run --pull <site>)"
  ;;

diff|push)
  known_site
  listing="$(remote_listing)"
  ;;
esac

case "$MODE" in
diff)
  echo "── $SITE: production vs sites/$SITE"
  printf '  %-42s %10s %10s  %s\n' FILE PRODUCTION MASTER STATE
  while IFS=$'\t' read -r sz rel; do
    [[ -z "$rel" ]] && continue
    m="$SITES_DIR/$SITE/$rel"
    if [[ ! -f "$m" ]]; then
      printf '  %-42s %10s %10s  %s\n' "$rel" "$sz" MISSING "only-on-server"
    else
      msz="$(stat -c %s "$m")"
      [[ "$msz" == "$sz" ]] && st="same" || st="CHANGED"
      printf '  %-42s %10s %10s  %s\n' "$rel" "$sz" "$msz" "$st"
    fi
  done <<<"$listing"
  while IFS= read -r f; do
    rel="${f#"$SITES_DIR/$SITE/"}"
    grep -qF $'\t'"$rel" <<<"$listing" || printf '  %-42s %10s %10s  %s\n' "$rel" "-" "$(stat -c %s "$f")" "new-in-master"
  done < <( { find "$SITES_DIR/$SITE" -type f 2>/dev/null || true; } | sort)
  ;;

pull)
  known_site
  require_ssh
  echo "── pull $SITE (production -> sites/$SITE)"
  have="$(count_files "$SITES_DIR/$SITE")"
  echo "  current master: $have file(s)"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  echo "  staging transfer (server-owned bytes excluded)…"
  rsync_pull "$SITE" "$TMP/"
  n="$(count_files "$TMP")"
  echo "  received $n file(s)"
  if (( n < have )); then
    echo "  REFUSING: master has $have file(s), transfer delivered $n." >&2
    echo "  A partial pull must not become the master. Nothing was written." >&2
    exit 1
  fi
  if (( have > 0 )); then
    BK="$SITES_DIR/.superseded/$SITE.$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$SITES_DIR/.superseded"
    cp -a "$SITES_DIR/$SITE" "$BK"
    echo "  superseded master kept at ${BK#"$REPO_ROOT"/}"
  fi
  mkdir -p "$SITES_DIR/$SITE"
  rsync -a --delete "$TMP/" "$SITES_DIR/$SITE/"
  echo "  master now holds $(count_files "$SITES_DIR/$SITE") file(s)"
  echo "  -> git add sites/$SITE && git commit   (an uncommitted master is not a master)"
  ;;

push)
  [[ -d "$SITES_DIR/$SITE" ]] || { echo "[sites-sync] no master at sites/$SITE — pull first" >&2; exit 2; }
  echo "── push $SITE (sites/$SITE -> production)"
  echo "  drift gate"
  drift=0
  while IFS=$'\t' read -r sz rel; do
    [[ -z "$rel" ]] && continue
    m="$SITES_DIR/$SITE/$rel"
    [[ -f "$m" ]] || continue
    msz="$(stat -c %s "$m")"
    if [[ "$msz" != "$sz" ]]; then
      echo "  DRIFT  $rel  production=$sz  master=$msz"
      drift=1
    fi
  done <<<"$listing"
  if (( drift )); then
    cat >&2 <<EOF

  REFUSING TO PUSH. Production has moved since the last pull.
  Pull first, re-apply your edits on the fresh master, then push:
      ./sites-sync.sh --pull $SITE

EOF
    exit 1
  fi
  echo "  no drift — production matches the master for every shared file"
  echo "  server-owned bytes this never touches:"
  python3 - "$ESTATE" "$SITE" <<'PY' | sed 's/^/    /'
import json,sys
est, site = sys.argv[1], sys.argv[2]
for p in json.load(open(est))["serverOwnedNeverRsync"]:
    if p.startswith(site + "/"):
        print(p)
PY
  echo
  echo "  ready. Publishing itself is one explicit command with a backup — see sites/README.md."
  ;;
esac