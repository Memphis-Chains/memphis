# Instalacja Memphis (PL)

> Kanoniczny przewodnik instalacji Memphis na czystym PC.
> Linux, macOS, WSL2. Windows: zainstaluj najpierw WSL2, potem postępuj jak Linux.
> Wersja angielska: [`install.en.md`](./install.en.md).

---

## TL;DR — Jednolinijkowa instalacja

Jeśli ufasz upstream'owemu instalatorowi:

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash
```

Instalator jest **idempotentny** i **interaktywny** — zapyta o zgodę przed instalacją pakietów systemowych. Audyt bez wprowadzania zmian:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh) --check-only --json
```

Po instalacji:

```bash
memphis init             # hasło + sejf + tożsamość (interaktywnie)
memphis doctor           # weryfikacja zdrowia systemu
memphis service install  # usługa systemd dla użytkownika
memphis service start    # start runtime'u
memphis tui              # natywny terminalowy cockpit
```

Tyle. Jeśli coś nie zadziała, zajrzyj do [`debug.pl.md`](./debug.pl.md).

---

## Wymagania wstępne

| Wymaganie | Po co | Auto-instalowane przez `install.sh`? |
|---|---|---|
| Linux / macOS / WSL2 | Natywny Windows nie jest wspierany | n/d |
| `git` | Klonowanie repo + pinowanie wersji | tak (apt/dnf/brew/pacman/zypper) |
| `curl` lub `wget` lub `python3` | Pobieranie | tak |
| `sudo` (lub root) | Instalacja pakietów systemowych | wymagane |
| Node.js ≥ v22 | Runtime Memphis | tak (NodeSource na Linux, brew na macOS) |
| Rust stable | Mostek NAPI + cratey | tak (rustup) |
| Toolchain budowy (cc, make, pkg-config, openssl, python3) | better-sqlite3 + natywne moduły NAPI | tak |
| Ollama (opcjonalne, ale zalecane) | Lokalny LLM + embeddingi | tak, jeśli potwierdzisz |

**Dysk:** ~2 GB na Memphis + zależności. **RAM:** minimum 2 GB, zalecane 8 GB. **CPU:** dowolny x86_64 od 2013+ (AVX). Stack sovereign-RAG działa na Intel i3-2120 (2011) bez GPU i bez internetu — to dolna granica sprzętowa.

---

## Instalacja manualna (alternatywa dla jednolinijkowca)

Jeśli wolisz krok po kroku:

```bash
# 1. Klon
git clone https://github.com/Memphis-Chains/memphis.git ~/memphis
cd ~/memphis

# 2. Zależności systemowe (Ubuntu/Debian — adaptuj dla innych dystrybucji)
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev python3 git curl

# 3. Node 22 (przez NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 4. Rust stable
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
source "$HOME/.cargo/env"

# 5. Opcjonalnie: Ollama (lokalny LLM + embeddingi)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull cogito:3b
ollama pull nomic-embed-text

# 6. Budowa Memphis
npm ci
npm run build

# 7. Link globalny CLI
npm link

# 8. Weryfikacja
memphis --version
```

Pełna izolowana ścieżka instalacji: [`docs/operator/CLEAN-INSTALL.md`](./CLEAN-INSTALL.md).

---

## Pierwsze uruchomienie

Memphis jest **bezstanowy po instalacji** — nie ma sejfu, tożsamości ani łańcuchów dopóki nie uruchomisz `memphis init`.

```bash
memphis init
```

Interaktywne pytania:
1. **Hasło operatora** — używane do podniesienia uprawnień do tier 2 (narzędzia write/execute). Wybierz mocne; będzie pytane przy każdym podniesieniu. Memphis nigdy go nie loguje.
2. **Hasło sejfu** — szyfruje sejf z sekretami (AES-256-GCM + Argon2id KDF). Inne niż hasło operatora.
3. **Pytanie + odpowiedź odzyskiwania** — używane gdy zapomnisz hasła sejfu. Zapisz oba w bezpiecznym miejscu. Odpowiedź jest hashowana, nie da się odzyskać oryginału.
4. **Nazwa agenta + nazwa właściciela** — kosmetyka, używana w wpisach łańcucha.

Po zakończeniu `memphis init`:

```bash
memphis doctor              # pełna weryfikacja
memphis health --json       # zdrowie w formie maszynowej
memphis service install     # instalacja usługi systemd (Linux)
memphis service start       # start daemona runtime
memphis service status      # potwierdzenie działania
```

Sprawdź czy daemon odpowiada:

```bash
memphis health
# oczekiwane: status=ok, vault=initialized, chains=ready
```

---

## Weryfikacja

Wszystkie poniższe muszą być zielone, żeby uznać instalację za kompletną:

```bash
memphis health                              # daemon dostępny
memphis doctor                              # wszystkie sprawdzenia OK
memphis vault list                          # sejf się otwiera (zapyta o hasło)
memphis journal "Pierwszy wpis pamięci"     # zapis do łańcucha działa
memphis recall "pierwszy wpis"              # wyszukiwanie semantyczne zwraca wpis
memphis chat --input "Cześć, Memphis."      # local-fallback lub Ollama odpowiada
memphis tui --check-only --json             # cockpit TUI startuje
```

Jeśli wszystko zielone — instalacja jest **gotowa do pierwszego testu produkcyjnego**.

---

## Częste błędy → rozwiązanie

| Błąd | Diagnoza | Naprawa |
|---|---|---|
| `Node.js v22+ required, found v20` | Stary Node | Uruchom instalator ponownie; lub `nvm install 22 && nvm use 22` |
| `rustc not found` | Rust nie w PATH | `source $HOME/.cargo/env` (dodaj do `~/.bashrc`) |
| `better-sqlite3` instalacja fail | Brak toolchain budowy | `sudo apt-get install build-essential python3` |
| `Cannot find module '@memphis-chains/memphis'` | Nie wykonano `npm link` | `cd ~/memphis && npm link` |
| `memphis: command not found` po `npm link` | Ścieżka linkera | Dodaj `$(npm prefix -g)/bin` do PATH |
| `vault unlock failed: invalid passphrase` | Literówka lub złe hasło | Użyj pytania/odpowiedzi odzyskiwania |
| `Connection refused on :3000` | Daemon nie wystartował | `memphis service start` |
| `Ollama unreachable` | Ollama nie działa | `ollama serve &` (lub pomiń — local-fallback to obsłuży) |
| `Chain corrupt` | Błąd dysku w trakcie zapisu | `memphis repair runtime --fix` |

Pełne drzewo troubleshootingu: [`debug.pl.md`](./debug.pl.md).

---

## Deinstalacja

```bash
memphis service stop
memphis service uninstall
npm unlink -g @memphis-chains/memphis
rm -rf ~/memphis ~/.memphis ~/.config/memphis
```

Usuwa runtime + stan. Aby zachować łańcuchy do archiwum, skopiuj `~/.memphis/chains/` w bezpieczne miejsce przed `rm -rf`.

---

## Powiązane dokumenty

- **Pierwsze kroki:** [`example-installation/`](./example-installation/)
- **Playbook debug:** [`debug.pl.md`](./debug.pl.md)
- **Referencja CLI:** [`CLI-REFERENCE.md`](./CLI-REFERENCE.md)
- **CLI sejfu:** [`VAULT-CLI.md`](./VAULT-CLI.md)
- **Przewodnik aktualizacji:** [`UPGRADE.md`](./UPGRADE.md)
- **Architektura (dla deweloperów):** [`../dev/CANONICAL-ARCHITECTURE.md`](../dev/CANONICAL-ARCHITECTURE.md)

---

_Ostatnia weryfikacja: 2026-04-19 względem `scripts/install.sh` + `scripts/bootstrap.sh` na Memphis v1.3.0._
