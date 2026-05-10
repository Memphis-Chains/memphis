# Memphis Daily Assistant — Setup Guide

> Cel: postawić Memphis lokalnie jako codzienny AI asystent z głosem, wzrokiem
> i dostępem do twojej maszyny. Poprzez Telegram (mobilny dostęp) i/lub TUI/Tauri
> (desktop cockpit). Dokument jest "all-in-one" — operator po przejściu od góry
> do dołu ma w pełni działającego dżina w komputerze.

---

## 0. Co dostajesz po pełnym setupie

| Capability | Surface | Status po setupie |
|---|---|---|
| Tekst chat z agentem | Telegram + TUI + CLI | ✅ |
| Voice input (mówisz → bot rozumie) | Telegram | ✅ (po Whisper :9000) |
| Voice output (bot mówi po polsku) | Telegram | ✅ (po Piper :5500) |
| Vision (foto → opis) | Telegram | ✅ (po Moondream + photo handler) |
| Self-modify (bot poprawia własny kod) | CLI/Telegram + tier 3 | ✅ |
| Chain memory (6500+ blocks, hybrid recall) | wszystkie surfaces | ✅ |
| Anthropic Claude Opus 4.6 reasoning | wszystkie surfaces | ✅ |
| Local Ollama fallback (offline-first) | wszystkie surfaces | ✅ |
| Proactive Assistant (bot pisze do ciebie sam) | Telegram | 🟡 wymaga env keys |

---

## 1. System pre-requisites

### 1.1 Hardware minimum

- Linux x64 (canonical) — macOS via build-from-source (#407), Windows nie
  jeszcze
- 8 GB RAM (16 GB komfortowo z voice + vision)
- 10 GB free disk (vault + chains + ollama models)
- Internet connection (do pull modeli + Anthropic API)
- GPU opcjonalnie — `i3-2120 + 16GB RAM` operator-tested CPU-only OK,
  voice latencja ~3-5s na zdanie

### 1.2 OS-level packages (sudo wymagane, jednorazowo)

**Zautomatyzowane** przez `scripts/install-prerequisites.sh`:

```bash
cd ~/memphis
bash scripts/install-prerequisites.sh
# → sudo apt-get install -y build-essential pkg-config libssl-dev
#   git curl wget ca-certificates python3 python3-pip python3-venv
#   jq zstd ffmpeg libasound2-dev tesseract-ocr tesseract-ocr-pol
# Plus Node.js 22 via NodeSource jeśli nie ma.
# Detect: Ubuntu/Debian → apt, Fedora/RHEL → dnf, WSL → apt.
```

**Krytyczne paczki** (uzasadnienie):
- `python3-venv` — bez tego `scripts/voice-install.sh` failuje (venv bez pip)
- `tesseract-ocr` + `tesseract-ocr-pol` — OCR adapter media pipeline
- `ffmpeg` + `libasound2-dev` — voice audio transcoding
- `build-essential` + `pkg-config` + `libssl-dev` — Rust napi crate compile

**Manualnie** (jeśli wolisz po jednej linii bez instalatora):

```bash
sudo apt update
sudo apt install -y \
  python3 python3-pip python3-venv \
  ffmpeg libasound2-dev \
  tesseract-ocr tesseract-ocr-pol \
  curl tar git build-essential \
  pkg-config libssl-dev jq zstd
```

Po wersji Python sprawdź czy active python minor matchuje (`python3 -m venv
/tmp/test-venv && rm -rf /tmp/test-venv` powinien przejść bez "ensurepip is
not available"). Jeśli pada, doinstaluj `python3.X-venv` matching aktywną
wersję.

### 1.3 Node.js + Rust

```bash
# Node 22+ (canonical):
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Rust stable:
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source $HOME/.cargo/env
```

### 1.4 Ollama (local LLM + embed runtime)

```bash
curl -fsSL https://ollama.com/install.sh | sh
# Daemon startuje przez systemd. Verify:
ollama list
```

---

## 2. Memphis clone + build

```bash
git clone https://github.com/Memphis-Chains/memphis.git ~/memphis
cd ~/memphis
./scripts/bootstrap.sh    # npm install + rust build:rust + tsc
memphis init              # vault passphrase, identity, first-run
memphis health            # sanity check — should show "ok: true"
```

`memphis init` poprowadzi przez:
- Operator passphrase (tier-3 unlock + recovery)
- Recovery question/answer (krytyczne dla disaster recovery)
- Vault pepper auto-generated 40-char strong (zapisz off-host!)
- DID generation (decentralized identity)

---

## 3. Daily-driver models — Ollama pull

```bash
# Reasoning + chat (jeśli chcesz lokalnie zamiast Anthropic):
ollama pull cogito:3b

# Embeddings (niezbędne dla chain recall — Memphis bez tego = ślepy):
ollama pull nomic-embed-text

# Vision (rozpoznawanie zdjęć z Telegrama):
ollama pull moondream

# Opcjonalnie — większe modele jeśli masz GPU:
# ollama pull llama3.1:8b-instruct-q4_K_M
# ollama pull qwen2.5-coder:7b-instruct
```

**Disk footprint:** ~3 GB (cogito + nomic + moondream).

---

## 4. Anthropic Claude (cloud reasoning)

Memphis defaults `DEFAULT_PROVIDER=anthropic` z modelem `claude-opus-4-6` +
fallback `claude-opus-4-7`. Wymaga klucza API od Anthropic console.

### 4.1 OAuth (preferred — auto-refresh)

```bash
memphis auth anthropic
# → otwiera browser, logujesz się przez Anthropic console,
#   refresh token zapisany w vault pod kluczem
#   anthropic_oauth_refresh_token, .env dostaje
#   ANTHROPIC_VAULT_KEY=anthropic_oauth_refresh_token
```

### 4.2 API key fallback

```bash
memphis auth provider anthropic --api-key sk-ant-...
# → klucz w vault pod anthropic_api_key, .env dostaje
#   ANTHROPIC_VAULT_KEY=anthropic_api_key
```

**Verify:** `memphis chat --provider anthropic --input "ping"` zwraca odpowiedź
z `"providerUsed":"anthropic","modelUsed":"claude-opus-4-6"`.

### 4.3 Per-model max_tokens (jeśli chcesz override)

W `.env`:
```
GEN_MAX_TOKENS=128000
ANTHROPIC_MODEL=claude-opus-4-6
ANTHROPIC_MODEL_FALLBACK=claude-opus-4-7
MEMPHIS_ANTHROPIC_CACHE=1
```

Adapter clampuje per-model (Sonnet 64k, Opus/Haiku 32k); 128000 nie 400'uje
na mniejszym modelu, tylko log warn `max_tokens clamped 128000 → 32000`.

---

## 5. Voice stack — Whisper STT + Piper TTS

### 5.0 Reboot survival (KRYTYCZNE — zrób to PRZED odpaleniem voice-install)

`scripts/voice-install.sh` stawia serwisy via `nohup` — **NIE przeżywają
rebootu**. Żeby Whisper + Piper startowały po każdym restarcie maszyny,
zainstaluj systemd user units:

```bash
cd ~/memphis
bash scripts/voice-systemd-install.sh
# Idempotent. Stawia:
#   ~/.config/systemd/user/memphis-piper-tts.service   (port 5500, gosia default)
#   ~/.config/systemd/user/memphis-whisper-stt.service (port 9000, medium INT8)
# Plus: enable + start dla obu, copy server scripts do
#   ~/.local/share/memphis/voice-server/ (persistent — /tmp znika po reboot)
```

`bash scripts/voice-systemd-install.sh --status` pokaże stan; `--stop`
zatrzyma; `--remove` cofnie instalację.

**Sprawdź `linger`:**

```bash
loginctl show-user $USER | grep Linger
# Jeśli Linger=no, voice usługi nie wystartują przed twoim pierwszym
# logowaniem po reboot. Włącz:
sudo loginctl enable-linger $USER
```

### 5.1 Pierwsza instalacja (jednorazowo)

```bash
cd ~/memphis
bash scripts/voice-install.sh
# Idempotent. Stawia:
#   - Whisper :9000 (faster-whisper medium INT8, OpenAI-compatible API)
#     w venv ~/.cache/whisper-server-venv
#   - Piper :5500 (CPU only, ~80 MB / voice)
#     w ~/piper/ z polskim głosem gosia (kobiecy, default)
#   - Drugi voice darkman (męski) opcjonalnie:
#     bash scripts/voice-install.sh --voice darkman
```

**Pre-req:** `sudo apt install python3-venv` (matching active python minor —
np. `python3.13-venv` dla Python 3.13). Bez tego venv jest pusty i Whisper
failuje przy starcie z `ModuleNotFoundError: faster_whisper`.

Po `voice-install.sh` + `voice-systemd-install.sh` masz pełny voice loop
przeżywający reboot.

### 5.1 Verify

```bash
curl http://127.0.0.1:9000/health    # Whisper
curl http://127.0.0.1:5500/health    # Piper
memphis doctor 2>&1 | grep "Voice stack"
```

Memphis doctor `Voice stack readiness: route=local` powinno być ✓ zamiast ✗.

### 5.2 Telegram voice loop

Bot domyślnie obsługuje `voice in` (operator wysyła głosówkę → Whisper →
Memphis → Anthropic) i `voice out` (Piper → Telegram). Komendy:
- `/voice on` — odpowiedzi tylko głosem
- `/voice off` — tylko tekst (default)
- `/voice status` — current state

Quota: 100 wiadomości głosowych dziennie (`MEMPHIS_VOICE_QUOTA_DAILY=100`).

---

## 6. Telegram bot

### 6.1 Stwórz bota

1. Telegram → `@BotFather` → `/newbot` → nazwa + handle
2. Skopiuj token (postaci `123456789:ABC...`)
3. `/setdescription`, `/setabouttext`, `/setuserpic` — UX polish

### 6.2 Wpisz token + allowlist

```bash
memphis vault entry-add telegram_bot_token <YOUR_TOKEN>
memphis vault entry-add telegram_allowed_user_ids <YOUR_TG_USER_ID>
# Twój user ID: zapytaj @userinfobot na Telegramie
```

W `.env` (powinny już być po `memphis init`):
```
MEMPHIS_TELEGRAM_BOT_TOKEN=VAULT:telegram_bot_token
MEMPHIS_TELEGRAM_ALLOWED_USER_IDS=VAULT:telegram_allowed_user_ids
MEMPHIS_CHANNEL_GATEWAY_ENABLED=true
```

### 6.3 Restart + verify

```bash
systemctl --user restart memphis     # lub `memphis restart`
tail ~/.memphis/logs/memphis.log | grep "Channel gateway started"
# → "Channel gateway started (Telegram), provider:anthropic, tools:41"
```

Wyślij `/status` do swojego bota — powinien odpowiedzieć tabelą.

---

## 7. Tier-3 (unrestricted mutation)

Domyślnie tier-2 = full companion mode (operator override + tools). Tier-3
to 3-godzinna sesja "unrestricted" — pozwala na:
- `memphis_self_modify` z dowolnym kodem (poza always-blocked paths .env/vault/.git)
- `MEMPHIS_AUTONOMY_MODE=full` env override
- `MEMPHIS_TIER3_FS_UNRESTRICTED=true` — fs write outside `~/memphis/`

```
# W Telegramie / TUI / CLI:
/tier 3 <operator-passphrase>

# Po 3h auto-revert. Manual revoke:
/tier revoke
```

5 min przed wygaśnięciem agent dostaje warning + lifecycle event.

**Bezpieczeństwo:** tier-3 działa na operator passphrase z `memphis init`.
Trzymaj passphrase off-host (password manager). Lokalnie testować można,
production audit chain zapisuje każdą tier-3 elevation.

---

## 8. Daily companion features

### 8.1 Proactive Assistant (bot pisze do ciebie sam)

Memphis ma `proactive-assistant` system: time-based + context-aware suggestions
push'owane na Telegram.

Aktywacja w `.env`:
```
MEMPHIS_PROACTIVE_ENABLED=true
MEMPHIS_PROACTIVE_TELEGRAM_USER_ID=<YOUR_TG_USER_ID>
MEMPHIS_PROACTIVE_INTERVAL_MIN=60
MEMPHIS_PROACTIVE_QUIET_HOURS=22:00-08:00   # don't bother during sleep
```

Przykłady wiadomości proactive:
- "Hej Wodzu, 14:00 — czas na journaling? Ostatnio trzy dni z rzędu o tej porze..."
- "PR #243 czeka 5 dni na review — chcesz że przeczytam diff i napiszę summary?"
- "Wczoraj decyzja o anthropic provider switch — sprawdź, że dziś działa"

### 8.2 Cron tasks (regular jobs)

```bash
memphis cron list                   # zobacz aktywne (default 6 tasków)
memphis cron run <id>               # manualny strzał
```

Defaultowe tasks:
- `morning-raport-wodzu` (10:00 daily) — git pull --ff-only + build verify
- `memphis-deep-dive-telegram` (08:00 daily) — codzienne podsumowanie chains
- `memphis-code-evolution-telegram` (co 4h) — refactor sugestie
- `memphis-docs-sync-telegram` (co 6h) — update doc fragments

### 8.3 Backup loop

```bash
memphis backup schedule --interval 24h
memphis backup run --once           # initial snapshot

# Off-host (krytyczne — single-machine = total loss risk):
crontab -e
# Add: 0 3 * * * rsync -a ~/.memphis/backups/ /mnt/external/memphis-backups/
```

---

## 9. Tauri GUI (Phase G — coming, opt-in beta)

Phase G jeszcze nie zaimplementowana w main. Skeleton w `apps/memphis-gui/`
(React + shadcn/ui + Tauri 2). Plan: 1-2 tyg pracy. Do tego czasu cockpit to
TUI (Rust crate `memphis-tui`).

```bash
memphis tui     # full-screen cockpit; F1 help, F2 mouse capture toggle
```

---

## 10. Memory + identity bootstrap

Memphis startuje z pustym `soul.user`. Bot konfabuluje "kim jesteś". Bootstrap
identity przez:

### Wariant A — przez bota (interaktywny)

Wyślij na Telegram:
> "Pamiętaj: jestem [imię], polski [zawód], buduję Memphis jako [cel]. 
> Lubię [preferencje]. Zapisz to do soul memory."

Bot wywoła `memphis_soul_write` (tier-2 require approval; potwierdź w Telegramie).

### Wariant B — bezpośrednio plik

```bash
# Edytuj ~/.memphis/config/soul-memory.json:
nano ~/.memphis/config/soul-memory.json
# Wypełnij user.languages, user.preferences, user.expertise, user.identity
# Restart daemon: systemctl --user restart memphis
```

### Wariant C — z chain history

Memphis automatycznie infer profile z journal/decision chains. Im więcej
piszesz/komunikujesz przez bota, tym lepszy automatyczny profile. `memphis
reflection cycle` co 12h aktualizuje `soul.self.learnings`.

---

## 11. Verify wszystko działa

```bash
memphis doctor
# Spodziewane: total=58 pass=≥50 warn=<8 fail=0
# Akceptowalne warns: alert transport (jeśli nie podpięty), kartograf
# checkpoints (Q2 N32), external plugin (opt-in)
```

Smoke test na Telegramie:
1. `/status` — table z health
2. `/mode B` — switch cognitive mode
3. `pamiętaj że X` — memory persistence
4. Wyślij głosówkę "test mikrofonu" → Whisper → odpowiedź
5. Wyślij zdjęcie → Moondream → opis (po ściągnięciu moondream + photo handler)
6. `/tier 3 <pass>` → "use memphis_self_modify żeby dodać comment do README" → bot snapshot+branch+commit

Jeśli każdy z tych 6 kroków działa — masz pełnego dżina. Jeśli któryś nie —
zacznij od `memphis doctor` żeby zobaczyć która warstwa kuleje.

---

## 12. Troubleshooting

### Bot nie odpowiada
- `systemctl --user status memphis` — daemon żyje?
- `tail ~/.memphis/logs/memphis.log | grep ERROR`
- `memphis doctor` — co warni

### Vault decryption failed
- Pepper drift między .env a vault-state.json — sprawdź `~/memphis/.env` ma
  nową wartość, restart daemon
- Jeśli wszystko zgine, recovery Q&A → `memphis vault recover`

### Voice nie działa
- `curl http://127.0.0.1:9000/health` (Whisper) i `curl http://127.0.0.1:5500/health` (Piper)
- Jeśli unreachable: `bash scripts/voice-install.sh --restart`
- Logi: `/tmp/whisper-server.log`, `/tmp/piper-server.log`

### `memphis tui` startuje ale 400's na chat
- Whitespace text block bug — sprawdź że masz Phase 9 fix (`fix/anthropic-whitespace-text-blocks` w main)
- `git log --oneline | grep whitespace`

### Self-modify failed
- Test gate failed → bot rolluje branch back; log w audit chain
  `memphis_self_modify.test_gate.failed`
- Operator passphrase wrong → `Tier 3 requires the operator passphrase` 

---

## Appendix A — Plik Memphis i co jest w środku

| Path | Co | Krytyczność |
|---|---|---|
| `~/memphis/` | git clone produkcyjny — kod, dist/, crates/, scripts/ | krytyczne |
| `~/memphis/.env` | runtime config — pepper, vault keys, provider keys, env tunables | KRYTYCZNE — backup off-host |
| `~/.memphis/` | runtime data — chains, vault, embed index, audit, config | KRYTYCZNE — backup |
| `~/.memphis/chains/` | append-only blockchain memory (journal/decisions/etc.) | KRYTYCZNE |
| `~/.memphis/config/soul-memory.json` | bot identity profile + learnings | ważne — łatwe do odtworzenia |
| `~/.memphis/config/soul-manifest.json` | autonomy mode, trust rules, tier-2 passphrase hash | KRYTYCZNE |
| `~/.memphis/vault-state.json` + `vault-entries.json` | encrypted secrets | KRYTYCZNE — pepper unwrap |
| `~/.memphis/logs/memphis.log` | runtime log (rotated) | debug only |
| `~/.cache/whisper-server-venv/` | Whisper venv | re-installable |
| `~/piper/` | Piper binary + voices | re-installable |

Backup priorytet: `~/.memphis/{chains,vault-*,config}/` + `~/memphis/.env`. To 
single point of recovery jeśli SSD padnie.

---

## Appendix B — Stack lokalnych GitHub buildujących bloków

| Projekt | Co | Link |
|---|---|---|
| `rhasspy/piper` | Neural TTS — Polish gosia/darkman, CPU 100ms | github.com/rhasspy/piper |
| `Systran/faster-whisper` | INT8 Whisper, OpenAI-compatible API | github.com/Systran/faster-whisper |
| `ollama/ollama` | Local LLM runtime — Llama, Qwen, cogito, moondream | github.com/ollama/ollama |
| `tesseract-ocr/tesseract` | OCR | github.com/tesseract-ocr/tesseract |
| `tauri-apps/tauri` | Rust+Web GUI — Phase G | github.com/tauri-apps/tauri |
| `tonsky/FiraCode` (font) | Monospace dla TUI | github.com/tonsky/FiraCode |

---

## Appendix C — Wersje i daty

- Memphis v1.8.0 — 2026-05-02 (canonical Linux x64)
- Anthropic API: claude-opus-4-6 (default), claude-opus-4-7 (fallback)
- Ollama: 0.4+ recommended
- Node: 22+
- Rust: 1.95+
- Python: 3.11+

Dokument zsynchronizowany z stanem 2026-05-10 (post 9-PR autonomy unblocking
session).
