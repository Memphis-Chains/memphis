#!/usr/bin/env bash
# Podmiana wagi basal na nowe wydanie i przemierzenie progów.
#
# Premiera basal-1.5: 5.10.2026 9:00. Ten skrypt zakłada, że wagi są już
# na Hugging Face (Remek/basal-1.5-mini / -4.5B / -max + warianty -GGUF).
#
# Czemu to w ogóle potrzebne: serwer czyta tokenizer, config i
# CALIBRATION.json z katalogu modelu, a wagi z pliku .gguf. Podmiana
# ścieżek to jedyne, co trzeba — zero zmian w basal_cpu.py. Ale strona
# autora ostrzega, że GGUF dziedziczy kalibrację z bf16, więc progi
# 0.93/0.74 NIE przenoszą się z poprzedniego wydania bez pomiaru. Ten
# skrypt mierzy, zamiast zakładać.
#
# Użycie:
#   bash scripts/basal/switch-model.sh Remek/basal-1.5-mini pawelkiszczak/basal-1.5-mini-GGUF
#   bash scripts/basal/switch-model.sh --check          # tylko sprawdź, czy wagi są na HF
set -uo pipefail

REPO="Remek"   # autor wystawił warianty -GGUF sam (Remek/basal-1.5-mini-GGUF)
BASAL_DIR="${MEMPHIS_BASAL_DIR:-$HOME/.local/share/basal}"
VENV="$BASAL_DIR/venv/bin/python"
HF_MODEL="${1:-}"
HF_GGUF_REPO="${2:-}"

# Prób na sucho bez restartu serwisu.
if [[ "${1:-}" == "--check" ]]; then
  shift || true
  for name in Remek/basal-1.5-mini Remek/basal-1.5-4.5B Remek/basal-1.5-max; do
    # HF zwraca 401 (nie 404) dla repo, które jeszcze nie istnieje, więc
    # porównujemy z kontrolnie zmyśloną nazwą: identyczny kod = nie ma.
    code=$(curl -s -o /dev/null -w '%{http_code}' "https://huggingface.co/api/models/$name")
    echo "  $name -> HTTP $code"
  done
  fake=$(curl -s -o /dev/null -w '%{http_code}' "https://huggingface.co/api/models/Remek/basal-nonexistent-xyz")
  echo "  (kontrola: Remek/basal-nonexistent-xyz -> HTTP $fake)"
  for m in Remek/basal-1.5-mini Remek/basal-1.5-4.5B Remek/basal-1.5-max; do
    g="$REPO/${m##*/}-GGUF"
    gc=$(curl -s -o /dev/null -w '%{http_code}' "https://huggingface.co/api/models/$g")
    echo "  $g -> HTTP $gc"
    [[ "$gc" == "200" ]] || continue
    curl -s "https://huggingface.co/api/models/$g" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for f in d.get('siblings', []):
    if f['rfilename'].endswith('.gguf'):
        print('     ', f['rfilename'])
"
  done
  exit 0
fi

[[ -n "$HF_MODEL" ]] || { echo "usage: $0 <Remek/basal-1.5-*> [gguf-repo] | --check" >&2; exit 2; }
[[ -x "$VENV" ]] || { echo "brak venv: $VENV (bash scripts/install-basal.sh)" >&2; exit 1; }

short="${HF_MODEL##*/}"
HF_GGUF_REPO="${HF_GGUF_REPO:-$REPO/$short-GGUF}"
gguf_name="${short}-Q8_0.gguf"   # repo GGUF nazywa plik jak model: basal-1.5-mini-Q8_0.gguf
model_dir="$BASAL_DIR/models/$short"
gguf_file="$BASAL_DIR/models/gguf/$gguf_name"

log() { printf '[basal-switch] %s\n' "$*"; }
die() { printf '[basal-switch] ERROR: %s\n' "$*" >&2; exit 1; }

# ── 1. tokenizer / config / CALIBRATION.json (wagi są w kroku 2) ──────
# snapshot_download ląduje w cache HF jako models--<org>--<name>/snapshots/<sha>,
# a NIE we wskazanej ścieżce. Pierwsza wersja tego skryptu sprawdzała
# $model_dir zaraz po pobraniu, więc CALIBRATION.json nigdy się nie pojawiał
# i skrypt kończył się "brak CALIBRATION.json" na czystym modelu.
if [[ -f "$model_dir/CALIBRATION.json" ]]; then
  log "katalog modelu już jest: $model_dir"
else
  log "pobieram metadane modelu $HF_MODEL (do cache HF)"
  snap=$("$VENV" -c "
from huggingface_hub import snapshot_download
print(snapshot_download('$HF_MODEL', allow_patterns=['*.json', '*.jinja', '*.txt', '*.md']))
") || die "pobieranie metadanych $HF_MODEL nie powiodło się"
  model_dir="$snap"
  log "model_dir = $model_dir"
fi
[[ -f "$model_dir/CALIBRATION.json" ]] || die "brak CALIBRATION.json w $model_dir (snapshot: $model_dir)"
log "CALIBRATION.json z nowego wydania: temperatury $(python3 -c "
import json;d=json.load(open('$model_dir/CALIBRATION.json'));print(d.get('temperature_per_prim',{}))
" 2>/dev/null)"

# ── 2. wagi Q8_0 ─────────────────────────────────────────────────────
if [[ -f "$gguf_file" ]]; then
  log "wagi GGUF już są: $gguf_file"
else
  log "szukam $gguf_name w $HF_GGUF_REPO"
  "$VENV" -c "
from huggingface_hub import hf_hub_download
import shutil, os
p = hf_hub_download('$HF_GGUF_REPO', '$gguf_name')
os.makedirs(os.path.dirname('$gguf_file'), exist_ok=True)
shutil.copy(p, '$gguf_file')
" || die "nie ma $gguf_name w $HF_GGUF_REPO — sprawdź listę plików (--check)"
fi

# ── 3. pomiar na REALNYM zbiorze, nie na jednym pytaniu ───────────────
# Progi 0.93/0.74 to jedyny powód istnienia tego skryptu, więc pomiar
# musi odpowiedzieć "co się zmieniło", a nie "jeden losowy wynik".
# Zbiór = 5 przypadków ze skrzynki.py (zgłoszenia bankowe + pilność),
# każdy z oczekiwaną etykietą, więc da się zliczyć trafność i to,
# ile z nich wpadłoby w AUTO przy danym progu.
probe() {
  "$VENV" - <<'PROBE'
import json, urllib.request
URL = "http://127.0.0.1:8000/v1/systemone"
CASES = [
    ("login", "Klient: od wczoraj nie mogę zalogować się do bankowości internetowej. Reset hasła nie działa.",
     "Do którego działu skierować zgłoszenie?",
     {"cards": "Reklamacje kart", "online": "Wsparcie bankowości elektronicznej", "loans": "Kredyty"}, "online"),
    ("karta", "Klient: karta płatnicza została zablokowana po trzech nieudanych próbach płatności.",
     "Do którego działu skierować zgłoszenie?",
     {"cards": "Reklamacje kart", "online": "Wsparcie bankowości elektronicznej", "loans": "Kredyty"}, "cards"),
    ("kredyt", "Klient informuje, że nie zapłacił raty kredytu w terminie, probo o rozłożenie na raty.",
     "Do którego działu skierować zgłoszenie?",
     {"cards": "Reklamacje kart", "online": "Wsparcie bankowości elektronicznej", "loans": "Kredyty"}, "loans"),
    ("niejasne", "Dzień dobry, mam pytanie.",
     "Do którego działu skierować zgłoszenie?",
     {"cards": "Reklamacje kart", "online": "Wsparcie bankowości elektronicznej", "loans": "Kredyty"}, None),
    ("pilne", "Klient: przelew 50 000 zł wstrzymany, konto zablokowane, grozi kara umowna, dzwonił 3 razy.",
     "Jak pilne jest zgłoszenie?",
     {"niska": "niska pilność", "srednia": "średnia pilność", "wysoka": "wysoka pilność"}, "wysoka"),
]
out = []
for name, state, q, crit, want in CASES:
    body = json.dumps({"state": state, "questions": {
        name: {"type": "choice", "instructions": q, "criteria": crit}}, "lang": "pl"}).encode()
    d = json.loads(urllib.request.urlopen(
        urllib.request.Request(URL, body, {"Content-Type": "application/json"}), timeout=1800).read())
    a = d["answers"][name]
    out.append({"name": name, "choice": a["choice"], "conf": a["confidence"],
                "want": want, "backend": d.get("usage", {}).get("backend"),
                "latency_ms": d.get("usage", {}).get("latency_ms")})
json.dump(out, open("/tmp/basal-probe-result.json", "w"))
PROBE
}
report() {
  local label="$1"
  [[ -f /tmp/basal-probe-result.json ]] || { echo "   brak wyniku"; return 1; }
  python3 - "$label" <<'RPT'
import json, sys
rows = json.load(open("/tmp/basal-probe-result.json"))
label = sys.argv[1]
print("   --- %s ---" % label)
correct = auto93 = auto74 = decidable = 0
for r in rows:
    ok = "?" if r["want"] is None else ("OK " if r["choice"] == r["want"] else "ZLE")
    if r["want"] is not None and r["choice"] == r["want"]:
        correct += 1
    # AUTO znaczy: model pewny. Poprawność AUTO liczymy tylko tam, gdzie
    # oczekiwanie jest znane — dla "niejasne" nie ma poprawnej etykiety,
    # więc ten przypadek ocenia sam po sobie: pewność = ostrożność modelu.
    if r["want"] is not None:
        decidable += 1
        if r["conf"] >= 0.93 and r["choice"] == r["want"]:
            auto93 += 1
        if r["conf"] >= 0.74 and r["choice"] == r["want"]:
            auto74 += 1
    print("   %-9s %-4s conf=%.3f %6.1fs  %s" % (
        r["name"], ok, r["conf"], r["latency_ms"]/1000.0, r["choice"]))
print("   trafność (4 z etykietą): %d/%d" % (correct, decidable))
print("   AUTO poprawne @0.93: %d/%d   @0.74: %d/%d" % (auto93, decidable, auto74, decidable))
RPT
}
rm -f /tmp/basal-probe-result.json
if curl -s -m 3 http://127.0.0.1:8000/health 2>/dev/null | grep -q '"ready":true'; then
  log "pomiar PRZED (stary model) — 5 przypadków, około 2-3 min"
  probe && report "przed" || log "pomiar przed nieudany"
fi

# ── 4. restart na nowej wadze ────────────────────────────────────────
log "restart systemd z BASAL_MODEL=$model_dir"
UNIT="$HOME/.config/systemd/user/memphis-basal-td.service"
if [[ -f "$UNIT" ]]; then
  # Nadpisania są w service.d/, nie w pliku unita — sed na unicie nic
  # by nie zrobił, a stary drop-in wskazywałby na poprzedni model
  # (taki drop-in z BASAL_MODEL=/test/model wyłączył serwis 04.10 wieczorem).
  mkdir -p "$HOME/.config/systemd/user/$UNIT.d"
  printf '[Service]\nEnvironment=BASAL_MODEL=%s\nEnvironment=BASAL_GGUF=%s\n' \
    "$model_dir" "$gguf_file" > "$HOME/.config/systemd/user/$UNIT.d/20-model.conf"
  log "zapisany drop-in $UNIT.d/20-model.conf"
  systemctl --user daemon-reload
fi
systemctl --user restart memphis-basal-td
for _ in $(seq 1 90); do
  sleep 2
  if curl -s -m 3 http://127.0.0.1:8000/health 2>/dev/null | grep -q '"ready":true'; then break; fi
done
curl -s -m 5 http://127.0.0.1:8000/health | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('[basal-switch] health: ready=%s backend=%s model=%s' % (d.get('ready'), d.get('backend'), d.get('model')))
raise SystemExit(0 if d.get('ready') else 'serwis nie wstał')
" || exit 1

# ── 5. pomiar PO: ten sam zbiór, te same progi ────────────────────────
log "pomiar PO (nowy model) — 5 przypadków"
rm -f /tmp/basal-probe-result.json
probe && report "po" || log "pomiar po nieudany"
log "gotowe. Progi 0.93 / 0.74 muszą być przemierzone na własnych danych — patrz skrzynka.py w $BASAL_DIR"
