# Instalacja Memphis

Przewodnik instalacji świeżego Memphis — suwerennego agenta AI z rdzeniem Rust + orchestracja TypeScript.

## Jednolinijkowiec (rekomendowany)

Linux / macOS / WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash
```

Installer auto-wykrywa Twój system + menedżer pakietów i robi wszystko:

1. Instaluje `git`, `curl` i toolchain C/C++ (`build-essential` / `Development Tools` / `base-devel` / Xcode CLI)
2. Instaluje **Node.js 22+** (z NodeSource / Homebrew / Twojej dystrybucji)
3. Instaluje **Rust stable** przez `rustup` (lub upgraduje z nightly)
4. Klonuje Memphis do `~/.memphis/memphis`
5. Buduje (`npm install` + `npm run build` — Rust crates + TypeScript)
6. Linkuje globalne `memphis` przez `npm link`
7. Drukuje banner z następnymi krokami

**Installer NIE tworzy soul state, vault'a ani tożsamości agenta.** Pierwszy run jest świadomym, oddzielnym krokiem — patrz [Po instalacji](#po-instalacji).

**Audit bez instalacji:**
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh) --check-only --json
```

**Zmienne środowiskowe (override):**

| Zmienna               | Domyślnie                                       | Cel                                            |
| --------------------- | ----------------------------------------------- | ---------------------------------------------- |
| `MEMPHIS_INSTALL_DIR` | `$HOME/.memphis`                                | Katalog nadrzędny dla checkout'u              |
| `MEMPHIS_TARGET_DIR`  | `$MEMPHIS_INSTALL_DIR/memphis`                  | Konkretna ścieżka checkout'u                  |
| `MEMPHIS_REPO_URL`    | `https://github.com/Memphis-Chains/memphis.git` | Alternatywny git remote                       |
| `MEMPHIS_YES=1`       | nieustawione                                    | Tryb non-interactive (auto-confirm prompts)   |

## Po instalacji

Te komendy w kolejności — krótkie, jawne, każda następna gating'owana sukcesem poprzedniej:

```bash
memphis init              # passphrase, vault, tożsamość, pierwsze chain'y
memphis doctor            # weryfikuj że wszystko zdrowe
memphis service install   # zainstaluj + włącz systemd user service
memphis service restart   # uruchom (lub zrestartuj) runtime
memphis tui               # otwórz natywną konsolę operatora
```

### Opcjonalnie: lokalny voice stack

Jeśli chcesz voice messages na Telegramie / TUI obsługiwane w 100% lokalnie (faster-whisper STT + Piper TTS, ~80 MB pl_PL voice):

```bash
memphis voice install                    # default: gosia (głos żeński)
memphis voice install --voice darkman    # głos męski
memphis voice status                     # potwierdź oba silniki reachable
```

Następnie w `.env` ustaw `MEMPHIS_VOICE_MODE=local` i zrestartuj service. Szczegóły: `docs/operator/voice-local-stt.md` + `voice-local-tts.md`.

### Codzienne komendy

```bash
memphis health                 # runtime health check
memphis service status         # czy daemon żyje?
memphis service logs -n 100    # ostatnie logi
memphis doctor --fix           # diagnoza + auto-naprawa degradacji
memphis providers list         # skonfigurowani providerzy LLM
memphis vault list             # podgląd wpisów vault
memphis vault add <key>        # zapisz sekret w szyfrowanym vault
memphis journal "<tekst>"      # wpis do chain'a journal
memphis recall "<query>"       # semantyczne wyszukanie (embedding-backed)
memphis search "<fraza>"       # exact search (FTS5-backed)
memphis evolve log             # historia self-modyfikacji agenta
memphis tui                    # interaktywna konsola
```

Pełny zestaw komend: `memphis --help`.

---

## Manual install

Jeśli wolisz instalować każdą zależność ręcznie (kontrybucja do Memphis, review build'u, air-gap maszyny, itd.) — patrz angielska wersja `INSTALL.md` — sekcja "Manual install". W skrócie:

### Wymagania

| Zależność  | Wersja                   | Wymagane    | Cel                                         |
| ---------- | ------------------------ | ----------- | ------------------------------------------- |
| Node.js    | 22.x LTS                 | Tak         | Runtime TypeScript + npm                    |
| Rust       | stable (1.75+)           | Tak         | Rust crates (memphis-core, memphis-napi…)   |
| Cargo      | (z Rust)                 | Tak         | Build crates + workspace                    |
| Git        | dowolna współczesna     | Tak         | Klonowanie repo + commit history            |
| build-essential / clang | C/C++ toolchain | Tak | Build NAPI bridge + onnxruntime-node       |
| Ollama     | latest                   | Opcjonalnie | Lokalny LLM provider (cogito:3b, qwen, …)   |
| Python 3.10+ | system                  | Opcjonalnie | Voice install (faster-whisper venv)         |

### Kroki

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
npm install
npm run build              # Rust workspace + TS compile
npm link                   # globalne `memphis` na PATH
npm run bootstrap          # .env z .env.example + provider audit + systemd unit
memphis init               # passphrase, vault, tożsamość
```

---

## Diagnoza po instalacji

```bash
memphis doctor              # podstawowy health check
memphis doctor --deep       # głębsza diagnoza (otwiera połączenia, czyta wszystkie chain'y)
memphis doctor --fix        # auto-naprawa znanych issue'ów
memphis doctor --post-install  # tylko po instalu — sprawdza .env, vault, systemd unit
journalctl --user -u memphis -n 100  # ostatnie 100 linii logu
systemctl --user status memphis      # stan systemd unit'u
```

## Najczęstsze błędy + naprawa

### `memphis init` mówi: "requires a configured .env file; run npm run bootstrap first"

```bash
cd ~/.memphis/memphis
npm run bootstrap
memphis init
```

### Service się crashuje (status 11/SEGV)

NAPI bridge crash. Najczęściej: stare procesy memphis trzymają port. Naprawa:
```bash
systemctl --user stop memphis
pkill -f 'dist/infra/cli/index.js'
systemctl --user start memphis
memphis health
```

### `embedding rebuild skipped: ollama timeout`

Ollama może być zimne — daj mu chwilę po starcie systemu:
```bash
ollama list   # poczekaj aż wraca
memphis repair runtime
```

### Voice install: `pip install faster-whisper` faila z PEP 668

Memphis voice installer obchodzi to przez venv. Jeśli próbujesz manual:
```bash
python3 -m venv ~/.cache/whisper-server-venv
~/.cache/whisper-server-venv/bin/pip install faster-whisper
```

### TUI nie pozwala scrollować

Naciśnij **PageUp** lub **F1** żeby zobaczyć keymap. **F2** przełącza mouse capture (gdy chcesz kopiować mysza).

### Kopiowanie tekstu z TUI nie działa

Mouse capture ON: **Shift+drag** żeby zaznaczyć (Linux), **Option+drag** (macOS).
Albo **F2** wyłącza capture na czas kopiowania, **F2** włącza ponownie.

---

## Co po wszystkim

- Quickstart 1-page'owy: `docs/operator/QUICKSTART.md`
- CLI reference: `docs/operator/CLI-REFERENCE.md`
- Voice runbook: `docs/operator/voice-local-stt.md` + `voice-local-tts.md`
- Architektura: `MEMPHIS_ARCHITECTURE_LAYERS.md`
- Roadmap: `docs/roadmap/Y1-2026-05-to-2027-05.md`

## Pomoc

- GitHub Issues: https://github.com/Memphis-Chains/memphis/issues
- Pełny help: `memphis --help`

---

*Memphis = suwerenny runtime agenta AI. Lokalny. Audytowalny. Bez chmurowego lock-in. Twoja maszyna, Twoje dane, Twoje klucze. Wyłączysz Internet — agent dalej działa.*
