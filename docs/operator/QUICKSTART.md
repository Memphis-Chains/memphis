# Memphis — Quickstart

> **Czas:** ~5 minut na świeżej maszynie
> **Wymagania:** Linux (Ubuntu LTS / Fedora / Arch / Debian) lub macOS lub WSL
> **Co dostajesz:** lokalny suwerenny agent AI z pamięcią, vault'em, TUI i opcjonalnym głosem PL

---

## Krok 1 — Instalacja

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash
```

Installer instaluje Node.js 22+, Rust stable, klonuje repo do `~/.memphis/memphis`, buduje krate Rust + TypeScript, linkuje globalne `memphis` na PATH. Trwa ~3-5 min na 4G LTE, ~1-2 min na światłowodzie.

**Audit bez instalacji:**
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh) --check-only --json
```

## Krok 2 — Pierwsza inicjalizacja

```bash
memphis init              # ustal passphrase, utwórz vault + tożsamość
memphis doctor            # sprawdź czy wszystko zdrowe
memphis service install   # zainstaluj systemd user unit
memphis service restart   # uruchom runtime
```

Memphis żyje na `127.0.0.1:3100`. Service idzie pod `~/.config/systemd/user/memphis.service`, restartuje się automatycznie przy crashu.

## Krok 3 — Pierwsze otwarcie

```bash
memphis tui
```

W TUI:
- Wpisz wiadomość → Enter, agent odpowie
- **`?`** lub **F1** → keymap (scroll, mouse toggle, vim, paste)
- **`/help`** → pełna lista komend
- **`/tier 3 <passphrase>`** → 3h tier-3 (full mutation), auto-revert

## Krok 4 (opcjonalnie) — Polish voice

Jeśli chcesz wysyłać voice messages na Telegrama i dostawać odpowiedź głosem (faster-whisper STT + Piper TTS, ~80 MB Polish voice download):

```bash
memphis voice install                    # default: głos żeński (gosia)
memphis voice install --voice darkman    # głos męski
memphis voice status                     # potwierdź że oba serwery żyją
```

Następnie w `~/memphis/.env` ustaw:
```
MEMPHIS_VOICE_MODE=local
WHISPER_SERVER_URL=http://127.0.0.1:9000
PIPER_SERVER_URL=http://127.0.0.1:5500
```

I `systemctl --user restart memphis.service`.

## Krok 5 (opcjonalnie) — Telegram

```bash
memphis telegram configure --bot-token <BOT_TOKEN_OD_BOTFATHER> \
                           --allowed-user-ids <TWOJ_TELEGRAM_USER_ID>
systemctl --user restart memphis.service
```

Po restarcie wpisz `/start` swojemu botowi na Telegramie.

---

## Pięć komend codziennego użytku

```bash
memphis tui                       # interaktywna konsola operatora
memphis health                    # runtime żyje?
memphis journal "tekst notatki"   # zapisz do chain'a journal
memphis recall "fraza"            # semantyczne wyszukanie w pamięci
memphis doctor --fix              # auto-naprawa degradacji
```

## Co jest na stałe lokalne

| Plik | Co zawiera |
|---|---|
| `~/.memphis/chains/` | Append-only chains (journal, decisions, soul, system, ...) |
| `~/.memphis/vault-entries.json` | Szyfrowane sekrety (provider keys, telegram token) |
| `~/.memphis/data/memphis.db` | SQLite — FTS5 index, sesje, cache |
| `~/.memphis/kartograf/active.onnx` | Embedding model (jeśli zainstalowany) |
| `~/memphis/.env` | Konfiguracja runtime |

**Nic nie wychodzi z Twojej maszyny dopóki sam nie skonfigurujesz providera chmurowego lub federacji.**

## Co dalej

- Pełny przewodnik instalacji: `INSTALL.md` w korzeniu repo (en)
- Polski install guide: `INSTALL.pl.md` w korzeniu repo
- Reference komend CLI: `docs/operator/CLI-REFERENCE.md`
- Troubleshooting: `memphis doctor --deep` + `journalctl --user -u memphis -n 100`
- Voice deep-dive: `docs/operator/voice-local-stt.md` + `voice-local-tts.md`

## Pomoc

- GitHub Issues: https://github.com/Memphis-Chains/memphis/issues
- Pełny help: `memphis --help`

---

*Memphis to suwerenny agent AI: lokalny, audytowalny, bez chmurowego lock-in. Dane są twoje. Klucze są twoje. Jeśli wyłączysz Internet — agent dalej działa.*

---

## Stara wersja API quickstart (legacy)

Pozostawiona dla kompatybilności. Świeży operator powinien zacząć od kroków 1-3 wyżej, nie od poniższego.

### Stary install (manual)

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
./scripts/install.sh
memphis health
```

### Stary HTTP API workflow

```bash
# Health
curl -s http://127.0.0.1:3100/health

# Generate
curl -s http://127.0.0.1:3100/v1/chat/generate \
  -H "Authorization: Bearer $MEMPHIS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":"Hello Memphis","provider":"auto"}'

# Journal + recall
curl -s http://127.0.0.1:3100/api/journal \
  -H "Authorization: Bearer $MEMPHIS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"First Memphis journal entry","tags":["onboarding"]}'
```

Reference: `docs/operator/API-REFERENCE.md`, `docs/operator/CLI-COMMAND-MATRIX.md`.
