# Memphis — instalacja od zera (dla świeżego użytkownika)

Ten dokument prowadzi Cię przez instalację Memphisa **bez niczyjej pomocy**. Każdy krok mówi: *co robisz*, *dlaczego*, *jaką komendę wpisać*, *co powinno się pojawić* i *jak poznać, że wyszło*.

Jeśli coś nie wychodzi — przeczytaj komunikat błędu, zajrzyj do sekcji [Gdy coś nie działa](#gdy-coś-nie-działa) na dole. Nie przeskakuj kroków.

---

## Czym jest Memphis

Memphis to lokalny agent AI, który działa **na Twoim komputerze**. W odróżnieniu od ChatGPT czy Claude:
- Nie wysyła Twoich danych do cudzej chmury (możesz używać lokalnego LLM — Ollama)
- Pamięta Twoje rozmowy w szyfrowanym pliku (vault + chain)
- Potrafi pisać w dzienniku, przypominać sobie wcześniejsze decyzje, uruchamiać narzędzia (czytać pliki, pytać się do internetu, wywoływać komendy)
- Jest sterowany przez operatora — Ty decydujesz co robi

Działa jako **usługa w tle** + **konsola tekstowa (TUI)** + **HTTP API** (jeśli chcesz własne GUI).

---

## Wymagania

| Co | Ile | Uwaga |
|---|---|---|
| System | Linux (Ubuntu 22/24, Debian 12, Fedora), macOS, WSL2 na Windows | Testowane najmocniej na Ubuntu 24.04 |
| RAM | minimum 8 GB, zalecane 16 GB | Bez RAM Ollama zadławi się na modelach 7B |
| Dysk | 20 GB wolnego miejsca | Sam Memphis ~2 GB, model Ollama 7B ~5 GB, reszta na chains/logi |
| Procesor | dowolny x86_64, 4 rdzenie | Intel i3 wystarczy; ARM (Raspberry Pi 5) też działa |
| Internet | tylko do pierwszego pobrania | Po instalacji działa offline |
| Dostęp do terminala | tak | Wszystko robi się przez wpisywanie komend |
| `sudo` | tak | Kilka pakietów wymaga instalacji systemowej |

---

## Jak korzystać z tego dokumentu

Każdy krok wygląda tak:

> ### Krok N — Tytuł
> **Co robisz:** jednym zdaniem
> **Dlaczego:** dlaczego to jest potrzebne
> **Komenda** (skopiuj dokładnie, wklej do terminala, naciśnij Enter):
> ```bash
> komenda tutaj
> ```
> **Czego się spodziewać:** co zobaczysz na ekranie
> **Weryfikacja:** jak sprawdzić, że się udało

Jeśli jakiś krok kończy się błędem — **zatrzymaj się**, przeczytaj sekcję Troubleshooting, i dopiero idź dalej.

---

## Krok 0 — sprawdź, że masz terminal i git

**Co robisz:** sprawdzasz, czy Twój system ma podstawowe narzędzia.
**Dlaczego:** bez terminala i gita nic nie zainstalujesz.

Otwórz terminal (na Ubuntu: `Ctrl+Alt+T`). Wpisz:

```bash
git --version && echo "---" && uname -a && echo "---" && whoami
```

**Czego się spodziewać:** coś w stylu
```
git version 2.43.0
---
Linux memphischains 6.8.0-110-generic #112-Ubuntu ...
---
twojalogin
```

**Weryfikacja:** jeśli `git --version` wypluło numer wersji — OK. Jeśli `git: command not found` — zainstaluj git:
```bash
sudo apt update && sudo apt install -y git
```

---

## Krok 1 — zainstaluj podstawowe pakiety systemowe

**Co robisz:** doinstalowujesz narzędzia które Memphis buduje w tle.
**Dlaczego:** Memphis kompiluje kod w Rust i TypeScript; potrzebuje kompilatora C/C++, narzędzi do rozpakowywania i kilku bibliotek.

**Komenda (Ubuntu/Debian):**
```bash
sudo apt update
sudo apt install -y git curl wget build-essential pkg-config zstd ffmpeg jq openssl ca-certificates
```

**Czego się spodziewać:** menedżer pakietów wylistuje ~30 pakietów, poprosi o potwierdzenie (naciśnij `Y` lub Enter), pobierze i zainstaluje. Trwa 1-3 minuty.

**Weryfikacja:**
```bash
gcc --version && curl --version | head -1 && zstd --version | head -1
```
Każda komenda powinna wypluć numer wersji. Jeśli wszystkie trzy OK — przejdź dalej.

> **Fedora**: zamiast `apt install` użyj `sudo dnf install git curl wget gcc gcc-c++ make pkgconf zstd ffmpeg jq openssl-devel`.
> **macOS**: `brew install git curl wget zstd ffmpeg jq` (build tools masz z Xcode CLI: `xcode-select --install`).

---

## Krok 2 — zainstaluj Node.js 22

**Co robisz:** instalujesz Node.js, środowisko w którym działa Memphis.
**Dlaczego:** większość Memphisa jest napisana w TypeScript — musi się uruchomić na Node.js. Wersja **22 lub nowsza** (sprawdzamy to niżej).

**Komenda (Ubuntu/Debian, z oficjalnego repo NodeSource):**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

**Czego się spodziewać:** skrypt NodeSource doda repozytorium, następnie `apt install` ściągnie Node.js. Trwa ~1 minutę.

**Weryfikacja:**
```bash
node --version
npm --version
```
`node` powinien zwrócić **v22.x.x** (cokolwiek większe od 22). `npm` powinien zwrócić ~10.x.x.

Jeśli `node --version` pokazuje v18 lub v20 — masz starszą wersję. Usuń ją: `sudo apt remove nodejs` i powtórz krok 2.

---

## Krok 3 — zainstaluj Rust

**Co robisz:** instalujesz Rusta, którym skompilujesz rdzeń Memphisa (kryptografia, szybkie wyszukiwanie, integralność danych).
**Dlaczego:** część Memphisa (vault z szyfrowaniem, hash-linked chain, embeddingi) jest w Ruście dla bezpieczeństwa i wydajności.

**Komenda:**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
source "$HOME/.cargo/env"
```

**Czego się spodziewać:** instalator `rustup` pobierze i zainstaluje Rusta + `cargo` (menedżer pakietów Rusta). Druga linia wczyta zmienne środowiskowe do aktualnej sesji.

**Weryfikacja:**
```bash
rustc --version
cargo --version
```
Powinno wypluć coś w stylu `rustc 1.8x.x` i `cargo 1.8x.x`.

> **Jeśli w kolejnej sesji terminala** `rustc: command not found` — dopisz do `~/.bashrc`: `source $HOME/.cargo/env`. Albo zrób: `echo '. "$HOME/.cargo/env"' >> ~/.bashrc && source ~/.bashrc`.

---

## Krok 4 — zainstaluj Ollama i pobierz model

**Co robisz:** instalujesz Ollama (lokalny silnik LLM) i pobierasz model językowy, z którym Memphis będzie rozmawiał.
**Dlaczego:** Memphis może używać chmury (Anthropic, MiniMax, OpenAI…) ale domyślnie woli **lokalny model** — wtedy Twoje rozmowy nie opuszczają komputera.

**Komenda:**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

**Czego się spodziewać:** instalator zainstaluje Ollama jako usługę systemową i uruchomi ją. Zobaczysz `>>> Installing ollama to /usr/local/bin...`.

Następnie pobierz model (~5 GB, potrzebuje internetu i ~10-30 min zależnie od łącza):

```bash
ollama pull qwen2.5:7b
```

**Czego się spodziewać:** pasek postępu pobierający warstwy modelu. Gdy skończy — zobaczysz `success`.

**Weryfikacja:**
```bash
ollama list
curl http://127.0.0.1:11434/api/tags
```
- `ollama list` pokaże tabelę z `qwen2.5:7b`
- `curl` powinien zwrócić JSON z listą modeli (to znaczy że Ollama słucha na porcie 11434)

> **Jeśli masz mniej niż 8 GB RAM** lub chcesz szybszy/mniejszy model: `ollama pull qwen2.5:3b` albo `ollama pull llama3.2:3b`. Zapamiętaj nazwę, wpiszesz ją w Kroku 7.

---

## Krok 5 — pobierz Memphisa

**Co robisz:** sklonujesz oficjalny kod Memphisa do folderu na swoim komputerze.
**Dlaczego:** potrzebujesz źródła żeby je skompilować i uruchomić.

**Komenda:**
```bash
cd ~
git clone https://github.com/Memphis-Chains/memphis.git memphis-v5
cd memphis-v5
```

**Czego się spodziewać:** `git` wyświetli pasek postępu (Receiving objects...). Całość ~45 MB, zajmie 10-60s zależnie od łącza.

**Weryfikacja:**
```bash
pwd
ls README.md package.json Cargo.toml
git log --oneline -3
```
- `pwd` powinien pokazać `/home/TWOJLOGIN/memphis-v5`
- `ls` powinien pokazać `README.md  package.json  Cargo.toml` (to znaczy jesteś w katalogu z kodem)
- `git log` pokaże trzy najnowsze commity — najwyższy powinien mieć tag `v1.4.0` albo nowszy

> **Uwaga**: jeśli wykonujesz ten dokument w ramach tego samego systemu, na którym już istnieje `memphis-v5` (bo został sklonowany wcześniej) — przejdź do Kroku 6. Jeżeli chcesz zacząć od zera: `rm -rf ~/memphis-v5` i powtórz krok 5.

---

## Krok 6 — zbuduj Memphisa

**Co robisz:** pobierasz zależności npm i kompilujesz Memphisa (Rust + TypeScript).
**Dlaczego:** pobrany kod sam z siebie nie działa — trzeba go przetłumaczyć do wersji wykonywalnej.

**Komenda (w katalogu `memphis-v5`):**
```bash
npm install
npm run build
```

**Czego się spodziewać:**
- `npm install` — pobranie ~600 pakietów npm (2-5 minut). Może być ostrzeżeń "deprecated" — zignoruj, jeśli komenda kończy się bez czerwonego `error`.
- `npm run build` — najpierw kompiluje Rust (pierwszy raz: **10-15 minut na Intel i3**, potem szybciej), potem TypeScript (1-2 minuty).

Gdy zobaczysz znak zachęty `$` z powrotem — skończyło się.

**Weryfikacja:**
```bash
ls dist/index.js
ls crates/memphis-napi/index.node
```
Oba pliki muszą istnieć. Jeśli któregoś brakuje — `npm run build` się nie udał. Zajrzyj do [Troubleshooting — build się nie udaje](#troubleshooting).

> **Dodanie globalnej komendy `memphis`:**
> ```bash
> sudo npm link
> which memphis   # powinno zwrócić ścieżkę
> memphis --version
> ```
> Jeśli nie chcesz używać `sudo npm link`, możesz uruchamiać lokalnie: `./bin/memphis.js <komenda>`. W tym guide zakładam że używasz `memphis` bez ścieżki.

---

## Krok 7 — skonfiguruj środowisko (plik `.env`)

**Co robisz:** tworzysz plik z konfiguracją — jaki model Ollama, gdzie zapisywać dane, jakim tokenem chronić HTTP API.
**Dlaczego:** Memphis nie zna Twoich preferencji — wszystko jest w `.env`.

**Komenda:**
```bash
cp .env.example .env
```

Teraz otwórz `.env` w edytorze (jeśli używasz `nano`):
```bash
nano .env
```

**Najpierw wygeneruj token API** (zawsze wymagany — pusty token = HTTP API zwraca 401 fail-closed; to celowe):
```bash
openssl rand -hex 32
```
Skopiuj wynik. Wkleisz go do `.env` poniżej.

**Co ustawić:**

```
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
MEMPHIS_API_TOKEN=<wklej-wynik-openssl>
DEFAULT_PROVIDER=ollama
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b                # jeśli pobrałeś inny model — wpisz jego nazwę
DATABASE_URL=file:./data/memphis.db
RUST_CHAIN_ENABLED=true
```

`MEMPHIS_API_TOKEN` jest **obowiązkowy** — to bearer token którym HTTP API i TUI się autoryzują. Jeśli go nie ma, każdy authenticated route `/v1/*` zwraca 401 z "MEMPHIS_API_TOKEN not configured". Generuj świeży na każdą instalację (nie używaj ponownie).

Zapisz plik: `Ctrl+O`, Enter, `Ctrl+X` (w `nano`).

**Weryfikacja:**
```bash
grep '^MEMPHIS_API_TOKEN\|^DEFAULT_PROVIDER\|^OLLAMA_MODEL' .env
```
Powinno pokazać Twoje trzy linie.

---

## Krok 8 — pierwsze uruchomienie: `memphis init`

**Co robisz:** inicjujesz tożsamość Memphisa — tworzysz hasło do vaultu, pytanie odzyskiwawcze, pierwsze wpisy w dzienniku.
**Dlaczego:** Memphis musi mieć **passphrase** (długie hasło) żeby zaszyfrować sekrety w vault. Bez tego nie możesz używać funkcji chronionych hasłem.

**Komenda:**
```bash
memphis init
```

**Czego się spodziewać:** seria pytań interaktywnych. Odpowiadaj w ten sposób:

1. **Passphrase** (dwie linie potwierdzenia) — wpisz długie hasło (min 12 znaków, najlepiej 20+). **Zapisz je w managerze haseł albo na papierze** — **bez niego stracisz dostęp do vaultu**.
2. **Recovery question** — pytanie które pamiętasz (np. "ulubiony nauczyciel z podstawówki")
3. **Recovery answer** — odpowiedź, pamiętaj **dokładnie** (wielkość liter, spacje — bez tego odzyskanie nie zadziała)
4. **Agent name** — nazwa Twojego agenta (np. "Memphis" albo własna)
5. **Owner name** — Twoja nazwa/nick (np. "Wodzu", "Marcin", "local operator")

Po odpowiedzeniu na wszystkie — Memphis utworzy pliki w `~/.memphis/` (stan agenta) i wypisze "Memphis initialized successfully".

**Weryfikacja:**
```bash
ls ~/.memphis/config/
```
Powinieneś zobaczyć: `soul-manifest.json`, `agent-profile.json`, `first-run.json`, `ISKRA.md` (tożsamość), `PULSE.md` (puls/heartbeat).

> **Zgubiłeś passphrase?** Odzyskiwanie przez recovery Q&A: `memphis vault recovery-unlock`. Jeśli zgubisz też recovery — straciłeś vault. Jedyna opcja: `rm -rf ~/.memphis` i zacząć od `memphis init` od nowa.

---

## Krok 9 — sprawdź, że wszystko działa: `memphis doctor`

**Co robisz:** uruchamiasz diagnostykę.
**Dlaczego:** doctor sprawdza czy: Rust bridge działa, Ollama odpowiada, chain się nie rozjechał, vault jest czytelny, wszystkie adaptery są healthy.

**Komenda:**
```bash
memphis doctor
```

**Czego się spodziewać:** tabelę z kolejnymi checkami, każdy z `[✓]` albo `[✗]`. Na końcu: `Summary: healthy` (zielony) albo `degraded`/`unhealthy`.

**Jeśli coś jest czerwone**, uruchom z auto-naprawą:
```bash
memphis doctor --fix
```

**Weryfikacja:**
```bash
memphis health
```
Powinno zwrócić `status: healthy` lub JSON z `"status":"healthy"`.

---

## Krok 10 — pierwsza rozmowa: `memphis tui`

**Co robisz:** otwierasz interaktywną konsolę Memphisa i rozmawiasz z nim pierwszy raz.
**Dlaczego:** `tui` = terminal UI, to Twój główny sposób używania Memphisa (poza API i TUI masz też `memphis ask "pytanie"` do pojedynczych pytań).

**Komenda:**
```bash
memphis tui
```

**Czego się spodziewać:** ekran podzielony na sekcje (historia, wejście, status). Wpisz:
```
Cześć, kim jesteś?
```
Naciśnij Enter. Memphis przez chwilę pomyśli (Ollama generuje odpowiedź lokalnie — pierwszy raz może trwać 5-30s bo model ładuje się do RAM), potem wypisze odpowiedź.

**Weryfikacja:** otrzymałeś odpowiedź po polsku (bo model `qwen2.5:7b` dobrze gada po polsku). Skrót klawiszowy wyjścia: `Ctrl+C` albo komenda `/exit`.

**Pierwsze rzeczy do spróbowania:**
```
Zapisz w dzienniku: zaczynam pracę nad Memphisem.
Co pamiętasz z naszej rozmowy?
Jakie masz narzędzia?
```

---

## Krok 11 — (opcjonalnie) uruchom jako usługa w tle

**Co robisz:** uruchamiasz Memphisa jako **usługę systemową**, żeby działał zawsze po starcie komputera.
**Dlaczego:** bez tego Memphis działa tylko gdy masz terminal otwarty. Usługa działa niezależnie.

**Komenda:**
```bash
memphis service install
memphis service status
```

**Czego się spodziewać:**
- `install` — zainstaluje plik `memphis.service` w `~/.config/systemd/user/`
  **i od razu włączy (`systemctl --user enable --now`) — nie trzeba osobnego `start`**
- `status` — pokaże czy usługa żyje (`active (running)`)
- Jeśli już była zainstalowana i chcesz ją ponownie odświeżyć: `memphis service restart`

**Sprawdź czy HTTP API słucha:**
```bash
curl http://127.0.0.1:3000/health
```
Powinno zwrócić `{"ok":true,...}` lub `{"status":"healthy"}`.

> **Jeśli używasz Memphisa tylko przez TUI — ten krok jest niepotrzebny**, możesz go pominąć. Wrócisz do niego, gdy postawisz serwer LAN albo GUI.

---

## Codzienne komendy (cheatsheet)

```bash
# Rozmowa
memphis tui                         # interaktywna konsola
memphis ask "jakie miałem zadania wczoraj?"   # pojedyncze pytanie

# Pamięć
memphis chain verify                 # sprawdzenie integralności chainów
memphis chain status                 # ile bloków, w jakich chainach
memphis embed store                  # przebudowa indeksu semantic search
memphis search --query "fraza"       # wyszukiwanie hybrydowe (semantyczne + FTS5)
# Zapisywanie do dziennika dzieje się automatycznie przez agenta
# (tool memphis_journal podczas rozmowy w `memphis tui` / `memphis ask`)

# Zarządzanie
memphis health                       # status runtime'u
memphis doctor                       # diagnostyka
memphis doctor --fix                 # diagnostyka + auto-naprawa
memphis service status|install|restart|uninstall   # zarządzanie usługą systemd --user
memphis service logs -n 50           # ostatnie 50 linii logów

# Sekrety (vault)
memphis vault list                   # jakie klucze są zapisane (bez wartości)
memphis vault add --key <nazwa> --value <wartość>  # zapisz sekret (lub pomiń --value → zapyta o wartość ukrytym promptem)
memphis providers list               # jakie modele AI masz podpięte

# Dane agenta
memphis soul read                    # co agent wie o sobie
memphis evolve log                   # historia samomodyfikacji agenta
```

---

## Gdy coś nie działa

### `node: command not found` albo `node --version` pokazuje v18/v20
Masz złą wersję. Usuń i zainstaluj 22:
```bash
sudo apt remove -y nodejs
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
```

### `rustc: command not found` w nowym terminalu
Rust nie został dodany do PATH. Dopisz do `~/.bashrc`:
```bash
echo 'source "$HOME/.cargo/env"' >> ~/.bashrc
source ~/.bashrc
```

### `npm run build` kończy się błędem Rusta
Sprawdź czy masz `build-essential` i `pkg-config`:
```bash
sudo apt install -y build-essential pkg-config
```
Potem wyczyść cache i spróbuj ponownie:
```bash
cd ~/memphis-v5
rm -rf node_modules target
npm install
npm run build
```

### `Ollama` nie odpowiada (connection refused na :11434)
```bash
systemctl status ollama
sudo systemctl start ollama        # jeśli nie działa
curl http://127.0.0.1:11434/api/tags
```
Jeśli `systemctl` mówi że nie ma takiej usługi:
```bash
ollama serve &                      # uruchom ręcznie w tle
```

### `memphis init` nie widzi Ollama
Sprawdź `.env`:
```bash
grep OLLAMA ~/memphis-v5/.env
ollama list                         # czy model jest pobrany?
```
Jeśli model inny niż `qwen2.5:7b` — zmień `OLLAMA_MODEL` w `.env` na dokładną nazwę z `ollama list`.

### `memphis` nie znaleziony po `npm link`
Użyj pełnej ścieżki:
```bash
cd ~/memphis-v5
./bin/memphis.js tui
```
Albo dopisz do `~/.bashrc`:
```bash
echo 'export PATH="$HOME/memphis-v5/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
memphis --version
```

### `memphis doctor` zwraca `chain integrity failure`
```bash
memphis doctor --fix
# jeśli nie pomaga:
rm -rf ~/.memphis
memphis init                        # zaczynasz od nowa — tracisz dotychczasowe wpisy
```

### TUI wywala dziwne znaki / nie wyświetla się dobrze
Terminal nie obsługuje UTF-8 albo kolorów. Sprawdź:
```bash
echo $TERM                          # powinno być xterm-256color albo screen-256color
locale | grep UTF-8
```
Jeśli nie — użyj innego emulatora terminala (GNOME Terminal, iTerm2, Alacritty) albo przełącz się na `memphis ask` zamiast TUI.

### Pierwsza odpowiedź Ollama trwa ponad minutę
Normalnie. Model ładuje się do RAM. Następne odpowiedzi w tej samej sesji są znacznie szybsze (~2-10s na i3).

### Komputer się zawiesza / wolny przy używaniu Memphisa
Ollama + Memphis + system ≈ 7-10 GB RAM. Na 8 GB RAM możesz zadławić swap. Rozwiązania:
- Mniejszy model: `ollama pull qwen2.5:3b` (2.5 GB zamiast 5 GB), zmień `OLLAMA_MODEL` w `.env`
- Zamknij przeglądarki i inne programy
- Docelowo: dobuduj RAM do 16 GB

---

## Co dalej

- **Rozbudowa o GUI / serwer LAN** → zajrzyj do `~/memphis-deploy/RUNBOOK.md` (jeśli masz pakiet LAN deploy)
- **Własny development** → zrób `git checkout -b moja-galaz`, zmień kod, `npm run build && memphis service restart`
- **Integracja z Claude / ChatGPT / Cursor** → dodaj klucz API przez `memphis vault add --key anthropic_api_key --value sk-...` (albo pomiń `--value` — dostaniesz ukryty prompt) i zmień `DEFAULT_PROVIDER=anthropic` w `.env`
- **Zapoznanie z komendami** → `memphis --help`, `memphis cognitive --help`, `memphis <komenda> --help`
- **Czytaj dokumentację** → `docs/operator/` zawiera pełny walkthrough w EN + PL

---

## Słowniczek (jeśli jakieś słowo jest nowe)

- **chain** — sekwencja zapisów (journal/decisions/reflections/cases) łączona hashem SHA-256. Jak księga rachunkowa której nie da się edytować.
- **vault** — zaszyfrowany magazyn sekretów (hasła API, dane kontaktowe). Odszyfrowuje się tylko Twoim passphrase.
- **provider** — źródło LLM-a. Może być lokalne (`ollama`) albo chmurowe (`anthropic`, `minimax`, `openai`).
- **NAPI** — Node.js API do kodu Rust. Plik `index.node` to skompilowany most między JavaScript i Rustem.
- **TUI** — Terminal User Interface. Interfejs tekstowy który działa w terminalu, bez przeglądarki.
- **MCP** — Model Context Protocol. Standard komunikacji między agentami AI i narzędziami. Memphis serwuje MCP na porcie 3001.
- **soul** — plik z tożsamością agenta (kim jest, co umie, jakie ma uprawnienia). W `~/.memphis/config/soul-manifest.json`.
- **doctor** — komenda diagnostyczna. Jak mechanik w serwisie — sprawdza wszystko, wskazuje co jest nie tak, czasem sam naprawia.
- **init** — komenda inicjalizująca. Robisz ją raz na początku, żeby Memphis miał tożsamość i vault.

---

**Koniec.** Jeśli dotarłeś tutaj i wszystko działa — masz u siebie w pełni lokalnego agenta AI z pamięcią, dziennikiem i szyfrowanym vaultem. Gratulacje.

Gdy jeszcze coś nie działa i nie ma tego w Troubleshooting — spójrz do `docs/operator/debug-playbook.md` w tym repo.
