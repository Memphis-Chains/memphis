#!/usr/bin/env bash
# schedule: 17 7 * * *
set -euo pipefail

#!/usr/bin/env bash
# schedule: 17 7 * * *
set -euo pipefail

#!/bin/bash
# Podmiana wag basal 1.0-1.5B → basal-1.5-mini po premierze 05.10.2026 09:00.
#
# NIE podmienia automatycznie: raportuje pojawienie się wag i czeka na
# decyzję operatora. Progi 0.93/0.74 muszą być przemierzone na nowym
# modelu — GGUF dziedziczy kalibrację bf16 (ostrzeżenie autorów).
# 1.5-mini ma gorszy Werdykt niż 1.0-4.5B (60,7% vs 66,0%), autor sam
# pisze "Mini nie spełnił celu 5% błędu" — to zamiana rozmiaru,
# nie upgrade jakości.

health=$(curl -s -m 5 http://127.0.0.1:8000/health 2>/dev/null || true)
echo "=== $(TZ=Europe/Warsaw date '+%F %T %Z') ==="
if [[ -z "$health" ]]; then
  echo "obecny serwis: NIE ODPOWIADA (port 8000 zamknięty)"
else
  echo "obecny serwis: $(printf '%s' "$health" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("ready="+str(d.get("ready")),"backend="+str(d.get("backend")),"model="+str(d.get("model")))' 2>/dev/null || echo "odczyt nieudany")"
fi

# 401 = repo nie istnieje (porównane z fikcyjnym: ten sam kod), 200 = są wagi.
code=$(curl -s -o /dev/null -w '%{http_code}' https://huggingface.co/api/models/Remek/basal-1.5-mini)
echo "HF Remek/basal-1.5-mini → HTTP $code"
if [[ "$code" != "200" ]]; then
  echo "wagi jeszcze nie na Hugging Face — nic nie ruszam"
  exit 0
fi

GGUF_REPO="Remek/basal-1.5-mini-GGUF"
gguf_code=$(curl -s -o /dev/null -w '%{http_code}' "https://huggingface.co/api/models/$GGUF_REPO")
echo "GGUF $GGUF_REPO → HTTP $gguf_code"
if [[ "$gguf_code" == "200" ]]; then
  echo "pliki GGUF:"
  curl -s "https://huggingface.co/api/models/$GGUF_REPO" \
    | python3 -c 'import sys,json;[print("  ",f["rfilename"]) for f in json.load(sys.stdin).get("siblings",[]) if f["rfilename"].endswith(".gguf")]' || true
fi
echo "revision: $(curl -s https://huggingface.co/api/models/Remek/basal-1.5-mini | python3 -c 'import sys,json;print(json.load(sys.stdin).get("sha",""))' 2>/dev/null || echo nieznana)"

MSG='📦 basal-1.5-mini jest na Hugging Face (z GGUF).

Nie podmieniłem modelu — progi 0.93/0.74 trzeba przemierzyć
na nowych wagach, bo GGUF dziedziczy kalibrację bf16.

Powiedz "podmien" to:
  1. pobiorę Remek/basal-1.5-mini + Q8_0
  2. przemierzę progi na 5 przypadkach skrzynki
  3. porównam odpowiedzi z 1.0-1.5B

Uwaga: mini ma gorszy Werdykt niż 1.0-4.5B (60,7% vs 66,0%).'
cd /home/memphis/memphis && node bin/memphis.js telegram send --value "$MSG"
