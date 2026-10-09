#!/usr/bin/env bash
# sites-health.sh — one audit for the whole web estate.
#
# Read-only. Touches nothing. Every finding is proven by a real HTTP request or a
# real remote stat, never by reading a config file and assuming.
#
# Usage:
#   ./sites-health.sh                audit every site
#   ./sites-health.sh marcin-kukla   audit one site
#   ./sites-health.sh --json         machine-readable output, for gating
#
# Env:
#   SITES_SSH_HOST    ssh host alias reaching the web server. Required for the
#                     docroot leak scan; every other check runs over HTTP only.
#   SITES_SSH_CONFIG  optional -F argument for ssh
#
# Exit codes:
#   0  no BLOCK finding
#   1  at least one BLOCK finding (a leak, a dead sitemap URL, a non-200 home)
#   2  harness error (missing tool, unknown site, bad env)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITES_DIR="$(cd "$HERE/.." && pwd)"
ESTATE="$SITES_DIR/estate.json"
REPO_ROOT="${MEMPHIS_REPO:-$(cd "$HERE/../.." && pwd)}"
SSH_HOST="${SITES_SSH_HOST:-}"
SSH_CONFIG_FILE="${SITES_SSH_CONFIG:-}"
REMOTE_ROOT="public_html"

[[ -f "$ESTATE" ]] || { echo "[sites-health] no estate.json at $ESTATE" >&2; exit 2; }
for tool in curl python3; do
  command -v "$tool" >/dev/null || { echo "[sites-health] $tool is required" >&2; exit 2; }
done
if [[ -n "$SSH_CONFIG_FILE" && ! -f "$SSH_CONFIG_FILE" ]]; then
  echo "[sites-health] SITES_SSH_CONFIG points at a missing file" >&2; exit 2
fi

SSH_OPTS=(-o ConnectTimeout=90 -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o BatchMode=yes)
[[ -n "$SSH_CONFIG_FILE" ]] && SSH_OPTS=(-F "$SSH_CONFIG_FILE" "${SSH_OPTS[@]}")

JSON=0; WANTED=()
for a in "$@"; do
  case "$a" in --json) JSON=1 ;; *) WANTED+=("$a") ;; esac
done

# This host drops roughly one connection in three. That is not an answer about
# access — retry, or you report "unreachable" for a healthy site.
# stdin is closed on purpose: ssh reads stdin, and a stray read eats the caller's
# loop input instead of returning.
ssh_retry() { # <remote-cmd>
  local out="" n=0
  while (( n < 5 )); do
    n=$(( n + 1 ))
    set +e; out="$(ssh "${SSH_OPTS[@]}" "$SSH_HOST" "$1" </dev/null 2>/dev/null)"; set -e
    [[ -n "$out" ]] && { printf '%s\n' "$out"; return 0; }
    sleep 5
  done
  echo "[sites-health] cannot reach the web server after 5 attempts" >&2
  return 2
}

ACC='[]'; BLOCKS=0; WARNS=0
_add() {
  ACC="$(python3 - "$1" "$2" "$3" "$4" "$ACC" <<'PY'
import json,sys
level,site,path,detail,acc = sys.argv[1:6]
try: arr = json.loads(acc)
except Exception: arr = []
arr.append({"level":level,"site":site,"path":path,"detail":detail})
print(json.dumps(arr, ensure_ascii=False))
PY
)"
  case "$1" in block) BLOCKS=$((BLOCKS+1)) ;; warn) WARNS=$((WARNS+1)) ;; esac
  return 0
}
rep() { # level site human detail
  case "$1" in
    info)  (( JSON )) || printf '  \033[36minfo\033[0m  %s\n' "$3" ;;
    ok)    (( JSON )) || printf '  \033[32m ok \033[0m  %s\n' "$3" ;;
    warn)  (( JSON )) || printf '  \033[33mwarn\033[0m  %s\n' "$3" ;;
    block) (( JSON )) || printf '  \033[31mBLOCK\033[0m  %s\n' "$3" ;;
  esac
  _add "$1" "$2" "$3" "$4"
  return 0
}
ingest() { # <json-array-of-findings>
  local arr="$1"
  ACC="$(python3 - "$ACC" "$arr" <<'PY'
import json,sys
acc = json.loads(sys.argv[1])
for f in json.loads(sys.argv[2]):
    acc.append(f)
print(json.dumps(acc, ensure_ascii=False))
PY
)"
  BLOCKS=$(( BLOCKS + $(python3 -c "import json,sys;print(sum(1 for f in json.load(sys.stdin) if f['level']=='block'))" <<<"$arr") ))
  WARNS=$(( WARNS + $(python3 -c "import json,sys;print(sum(1 for f in json.load(sys.stdin) if f['level']=='warn'))" <<<"$arr") ))
  return 0
}

http_code() { curl -s -o /dev/null -w '%{http_code}' -m 25 "$1" || echo 000; }
http_size() { curl -s -o /dev/null -w '%{size_download}' -m 25 "$1" || echo 0; }

probe_home() {
  local key="$1" domain="$2" code sz wire h
  code="$(http_code "$domain/")"
  if [[ "$code" != 200 ]]; then rep block "$key" "/" "$key / -> HTTP $code (expected 200)" "home HTTP $code"; return 0; fi
  sz="$(http_size "$domain/")"
  rep info "$key" "/" "$key / -> 200 ${sz}B" "home 200 ${sz}B"

  # gzip proven on the wire. Assuming it from the .htaccess is how you ship a
  # config that does nothing.
  wire="$(curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}' -m 25 "$domain/")"
  if [[ "$wire" -gt 0 && "$wire" -lt "$sz" ]]; then rep info "$key" "/" "$key gzip live (${sz}B -> ${wire}B)" "gzip ${sz}->${wire}"
  else rep warn "$key" "/" "$key gzip not effective (raw ${sz}B, wire ${wire}B)" "gzip raw=${sz} wire=${wire}"; fi

  h="$(curl -sI -m 25 "$domain/")"
  grep -qi 'strict-transport-security' <<<"$h" || rep warn "$key" "/" "$key no HSTS" "missing HSTS"
  grep -qi 'x-content-type-options'  <<<"$h" || rep warn "$key" "/" "$key no X-Content-Type-Options" "missing nosniff"
  grep -qi 'x-frame-options'         <<<"$h" || rep warn "$key" "/" "$key no X-Frame-Options" "missing X-Frame-Options"
  grep -qi 'referrer-policy'         <<<"$h" || rep warn "$key" "/" "$key no Referrer-Policy" "missing Referrer-Policy"
  return 0
}

standards() {
  local key="$1" domain="$2" f code marker body
  while read -r f; do
    [[ -z "$f" ]] && continue
    code="$(http_code "$domain/$f")"
    [[ "$code" != 200 ]] && rep warn "$key" "/$f" "$key /$f -> HTTP $code" "/$f HTTP $code"
  done < <(python3 -c "import json,sys;print('\n'.join(json.load(open(sys.argv[1]))['checks']['requiredPublicFiles']))" "$ESTATE")

  # A 404 page on disk proves nothing: Apache serves it only via ErrorDocument.
  # Request a URL that cannot exist and read the body.
  marker="no-such-page-$$"
  body="$(curl -s -m 25 "$domain/$marker")"
  if grep -qiE 'memphis|oswobodzeni|kukla|holiskool|sowhat' <<<"$body"; then
    rep info "$key" "/" "$key 404 handler renders a branded page" "404 handler branded"
  else
    rep warn "$key" "/<missing>" "$key 404 handler is the bare Apache default" "404 handler is server default"
  fi
  return 0
}

sitemap() {
  local key="$1" domain="$2" sm n=0 bad=0 u code
  sm="$(curl -s -m 25 "$domain/sitemap.xml")"
  if [[ -z "$sm" ]] || ! grep -q '<urlset' <<<"$sm"; then
    rep warn "$key" "/sitemap.xml" "$key /sitemap.xml missing or malformed" "sitemap missing/malformed"; return 0
  fi
  while read -r u; do
    [[ -z "$u" ]] && continue
    n=$(( n + 1 )); code="$(http_code "$u")"
    [[ "$code" != 200 ]] && { bad=$(( bad + 1 )); rep block "$key" "$u" "$key sitemap URL HTTP $code: $u" "sitemap URL $u HTTP $code"; }
  done < <(grep -o '<loc>[^<]*</loc>' <<<"$sm" | sed 's/<[^>]*>//g')
  (( n > 0 && bad == 0 )) && rep info "$key" "/sitemap.xml" "$key sitemap: $n/$n URLs resolve" "sitemap $n/$n ok"
  return 0
}

links() {
  local key="$1" domain="$2" path="$3" body l abs code seen=""
  body="$(curl -s -m 25 "$domain$path")"
  [[ -z "$body" ]] && return 0
  while read -r l; do
    case "$l" in http*|//*|mailto:*|tel:*|data:*|javascript:*|'#'*|'') continue ;; esac
    [[ "$l" == /* ]] || continue
    abs="$domain$l"
    [[ "$seen" == *"|$abs|"* ]] && continue
    seen+="|$abs|"
    code="$(http_code "$abs")"
    [[ "$code" != 200 ]] && rep warn "$key" "$l" "$key internal link HTTP $code: $l" "internal link $l HTTP $code"
  done < <(grep -oE '(href|src)="[^"]*"' <<<"$body" | sed 's/.*="//;s/"$//' | sort -u)
  return 0
}

leaks() {
  local key="$1" domain="$2" listing tmp
  if [[ -z "$SSH_HOST" ]]; then rep warn "$key" "/" "$key leak scan skipped: set SITES_SSH_HOST" "leak scan skipped"; return 0; fi
  listing="$(ssh_retry "cd $REMOTE_ROOT/$key && find . -type f -printf '%s\t%P\n'" 2>/dev/null || true)"
  [[ -z "$listing" ]] && { rep warn "$key" "/" "$key could not list the docroot" "docroot listing failed"; return 0; }
  tmp="$(mktemp)"
  printf '%s\n' "$listing" > "$tmp"
  local out
  set +e
  out="$(python3 "$HERE/leakscan.py" --domain "$domain" --listing "$tmp" --json 2>/dev/null)"
  local rc=$?
  set -e
  rm -f "$tmp"
  if [[ -z "$out" ]]; then rep warn "$key" "/" "$key leak scan produced no output" "leakscan empty"; return 0; fi
  ingest "$(python3 -c "import json,sys;print(json.dumps(json.loads(sys.stdin.read())['findings']))" <<<"$out")"
  local s
  s="$(python3 -c "import json,sys;d=json.load(sys.stdin)['summary'];print(f\"{d['domain']}: docroot {d['docroot_files']} file(s), crawl reached {d['crawl_reached_paths']} path(s) in {d['crawl_pages_fetched']} fetch(es), BLOCK {d['blocks']}, warn {d['warns']}\")" <<<"$out")"
  rep info "$key" "/" "$s" "$s"
  return 0
}

drift() {
  local key="$1" domain="$2" dir="$3" live reposz mastersz
  live="$(http_size "$domain/")"
  reposz="-"; mastersz="-"
  [[ -f "$REPO_ROOT/$dir/index.html" ]] && reposz="$(stat -c %s "$REPO_ROOT/$dir/index.html")"
  [[ -f "$SITES_DIR/$key/index.html" ]] && mastersz="$(stat -c %s "$SITES_DIR/$key/index.html")"
  # `repo` here is the estate master (sites/<site>/), not a sibling copy. If a
  # second tree also holds the site, that is an ambiguity worth reporting rather
  # than a fact to print — two masters means one of them will be published by
  # someone who picked wrong.
  rep info "$key" "index.html" "$key index.html live=${live}B master=${mastersz}B" "sizes live=$live master=$mastersz"
  # The master is the source of truth. When it differs from production the
  # useful question is which way: an unpublished local edit (fine, publish it)
  # or a production change nobody pulled yet (dangerous, would be reverted).
  # Reporting both as "drift" leaves the operator to guess which one it is.
  if [[ "$mastersz" != "-" && "$mastersz" != "$live" ]]; then
    rep warn "$key" "index.html" "$key master ($mastersz B) differs from live ($live B) — run --diff and decide whether to publish or pull" "master!=live ($mastersz vs $live)"
  elif [[ "$mastersz" == "$live" ]]; then
    rep info "$key" "index.html" "$key master matches production ($mastersz B) — nothing unpublished" "master==live"
  fi
  [[ "$reposz" == "-" ]] && rep warn "$key" "index.html" "$key has no estate.json master" "no estate master"
  # A second tree holding the same site means two sources of truth. Say so.
  local dupes
  dupes="$(python3 - "$REPO_ROOT" "$key" <<'PY2'
import sys, pathlib
root, key = pathlib.Path(sys.argv[1]), sys.argv[2]
master = (root / "sites" / key).resolve()
hits = []

# A second copy of a site is a real problem: two masters for one domain is how
# a stale file gets published. But it has to be attributed to the right site.
#
# The earlier version compared a candidate index.html against the master of
# whatever site was being audited, so `docs/site/` - a stale snapshot of
# memphis-v5 - came back as a "duplicate" of marcin-kukla and holiskool too,
# because it differs from all three. Three findings, one real problem.
#
# Attribute by similarity across all masters instead: a candidate is a copy of
# the site whose master it most resembles.
def read(pth):
    try:
        return pth.read_bytes()
    except OSError:
        return b""

masters = {}
for other_key in ("memphis-v5", "marcin-kukla", "holiskool"):
    mb = read(root / "sites" / other_key / "index.html")
    if mb:
        masters[other_key] = mb

def closest(cand_bytes):
    """Which master's page does this candidate most resemble?"""
    cl = set(cand_bytes.splitlines())
    best, best_score = None, -1.0
    for mk, mb in masters.items():
        ml = set(mb.splitlines())
        inter = len(cl & ml)
        union = len(cl | ml) or 1
        score = inter / union
        if score > best_score:
            best, best_score = mk, score
    return best, best_score

for cand in ("docs/site", "public/sites-deploy", "sites-discovery"):
    p = (root / cand).resolve()
    if not p.is_dir() or p == master:
        continue
    q = p / key
    if q.is_dir() and (q / "index.html").is_file():
        q = q
    elif not (p / "index.html").is_file():
        continue
    else:
        q = p
    body = read(q / "index.html")
    if not body:
        continue
    owner, score = closest(body)
    # Same site, and not byte-identical: a genuine second copy.
    if owner == key and score > 0.5:
        hits.append(f"{q.relative_to(root)}/")

print(" ".join(hits))
PY2
)"
  if [[ -n "$dupes" ]]; then
    rep warn "$key" "index.html" "$key also has a copy under: $dupes — the estate master is sites/$key/; consolidate before the next publish" "duplicate trees: $dupes"
  fi
  [[ "$mastersz" == "-" ]] && rep warn "$key" "index.html" "$key has no sites/$key master" "no sites/ master"
  return 0
}

# Read the site list into an array first. Piping a `while read` loop straight
# from process substitution means any command inside that reads stdin — ssh, most
# obviously — consumes the rest of the list and the loop stops after one site.
mapfile -t SITE_ROWS < <(python3 - "$ESTATE" <<'PY'
import json,sys
for s in json.load(open(sys.argv[1]))["sites"]:
    print(f"{s['key']}\t{s['domain']}\t{s['dir']}")
PY
)

run_all() {
  local row key domain dir w found
  for row in "${SITE_ROWS[@]}"; do
    IFS=$'\t' read -r key domain dir <<<"$row"
    [[ -z "$key" ]] && continue
    if (( ${#WANTED[@]} > 0 )); then
      found=0
      for w in "${WANTED[@]}"; do [[ "$w" == "$key" ]] && found=1; done
      (( found )) || continue
    fi
    (( JSON )) || { echo; echo "── $key ($domain)"; }
    probe_home "$key" "$domain"
    standards "$key" "$domain"
    sitemap "$key" "$domain"
    links "$key" "$domain" "/"
    leaks "$key" "$domain"
    drift "$key" "$domain" "$dir"
  done
  return 0
}

run_all
if (( JSON )); then
  python3 - "$ACC" <<'PY'
import json,sys
arr = json.loads(sys.argv[1])
b=[a for a in arr if a["level"]=="block"]; w=[a for a in arr if a["level"]=="warn"]
print(json.dumps({"sites":sorted({a["site"] for a in arr}),"block":len(b),"warn":len(w),"findings":arr}, ensure_ascii=False, indent=2))
PY
else
  echo; echo "── summary"; echo "  BLOCK: $BLOCKS   warn: $WARNS"
fi
if (( BLOCKS > 0 )); then exit 1; fi
exit 0