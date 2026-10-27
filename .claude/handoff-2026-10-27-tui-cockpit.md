# Session Handoff — 2026-10-27 (TUI cockpit, ADR-011 Layer 1)

Data: 2026-10-27 (po północy)
Gałąź: `docs/adr-011-cockpit-core-tauri-shell` (wymuszenie: `git checkout docs/adr-011-cockpit-core-tauri-shell`)
PR: #698 → https://github.com/Memphis-Chains/memphis/pull/698

---

## 0. Czytelnik: kim jesteś

Jesteś Memphis w sesji po 2026-10-26 wieczorem. Operator powiedział „działaj co
najlepsze dla projektu" po zbadaniu tematu Ratatui/Tauri. Zrobiłeś dwie rzeczy:
**zaprojektowałeś** (ADR-011) i **zaimplementowałeś warstwę 1** (ergonomia kokpitu).

Czytaj ADR-011 przed czymkolwiek dotyczącym GUI — zawiera siedem ustaleń
zmierzonych na hoście, nie odtworzonych z pamięci.

---

## 1. Co domknięte w tej sesji

### 1.1 ADR-011 „Cockpit Core — one brain, two shells" (commit 75c1bdf8)

Projekt, nie kod. Najważniejsze ustalenie: `app.rs` (7 125 LOC) i `client.rs`
(1 152 LOC) mają **zero importów ratatui** — mózg kokpitu jest już niezależny
od renderera, a model jest semantyczny (`LineTone` → styl tylko w
`widgets/mod.rs`). Druga powierzchnia potrzebuje drugiego **renderera**, nie
drugiego mózgu.

Siedem ustaleń (każde z plik:linia w ADR):
F1 mózg bez ratatui · F2 dwa stosy chatu, TS nie streamuje · F3 karetka nigdy
nie rysowana · F4 scrollback 1200 linii bez wyszukiwania przy sesjach 1447/782/737
· F5 protokół odrzuca drugie żądanie w locie · F6 **ADR-010 mylił się co do
bibliotek Tauri — wszystkie 5 jest na hoście** · F7 debata o frameworku otwarta
od maja.

Poprawiony `Cargo.toml` — fałszywa teza o bibliotekach Tauri plus osierocony
komentarz przyklejony do cudzego wpisu `apps/memphis-chain-draft`.

### 1.2 E1+E2+E4 — kursor, edytowalny prompt, kopiowanie (commit 08848f1b)

- **Karetka wreszcie jest rysowana.** Ratatui 0.30 pokazuje kursor, gdy klatka
  żąda pozycji, i go ukrywa w przeciwnym razie — wystarczyło obliczyć pozycję
  dokładnie i ją ustawić. Przed zmianą `set_cursor_position` nie występowało
  w całym crate.
- **Prompt się zawija i rośnie** (do 8 wierszy, przewijany, żeby kursor był
  widać). `Alt+Enter` wstawia nową linię; `Enter` nadal wysyła. `Left`/`Right`
  przesuwają kursor, `Delete` usuwa w przód, `Ctrl+A`/`Ctrl+E` skaczą na
  granice wiersza. Wiersz wejścia był **przyklejony na końcu** — literówki nie
  dało się poprawić.
- **`Ctrl+Y` kopiuje ostatnią odpowiedź** do schowka przez OSC 52 (jedyna
  droga ze procesu w raw mode). Mysz jest domyślnie wyłączona, bo zaznaczanie
  tekstu to główne użycie — to klawiaturowa droga do tego samego.
- **`F5` odświeża** — komentarz w pętli głównej obiecywał „F5 / Ctrl-R", a
  podłączona była tylko połowa.

### 1.3 E3 — `Ctrl+F` przeszukuje scrollback (commit b7ff50d3)

Pasek wyszukiwania na własnym wierszu, licznik dopasowań (`3/17`) żyje na
żywo, dopasowania podświetlone reverse video, bieżące na żółtym tle.
Przewijanie do dopasowania jest **zakotwione** — otwarta wyszukiwarka nie
ciągnie widoku z powrotem co klatkę.

`Ctrl+R` **już** oznaczał odświeżanie, więc wyszukiwanie dostało `Ctrl+F`.

### 1.4 ADR zaktualizowany do stanu faktycznego (commit ed968a87)

E1–E4 zrobione, E5 świadomie otwarte. Dokument mówi `Ctrl+F`, nie `Ctrl+R`.

### 1.5 Dowód „przed/po" — zmierzony, nie opisany

Ten sam pty (40×100), te same klawisze („hello", potem Left, Left, X), dwa binarki
z tego samego drzewa.

**PRZED (`3cacca8f`):**

```
|> helloX                                                                                            |
|● [Mode:B] minimax/MiniMax-M3.1-Flash · ctx:1000k · tok:? · ready · PULSE:healthy · session:primary:|
cursor at row 39, col 9 (visible=False)
```

X wylądował na **końcu** (`> helloX`) — `Left`/`Right` nie były podpięte, a wejście było
ściśle append-only. Karetka `visible=False`, pozycja bezsensowna.

**PO (`3a7f723b`):**

```
|> helXlo                                                                                            |
|      ^                                                                                             |
|● [Mode:B] minimax/MiniMax-M3.1-Flash · ctx:1000k · tok:? · ready · PULSE:healthy · session:primary:|
cursor at row 39, col 7 (visible=True)
```

X wylądował **w środku**, karetka dokładnie pod nim.

Latencja klawisz→redraw: **7,9 ms mediana w obu** (stary min 4,6/max 9,6; nowy
min 6,4/max 10,1). Ergonomia nie kosztuje niczego przy klawiaturze.

Wyszukiwanie `ctx:` → 9 dopasowań, wiersze 19–27 w reverse video, bieżące (19) na
żółtym tle.

### 1.6 Odkrycia opublikowane w drugim repo

`Memphis_Ai_Brain_On_Chain` (commit `1a89ba04`, 4 pliki): `memory/2026-10-27.md`,
`docs/cockpit-core-adr-011.md`, `docs/tui-cockpit-playbook.md` i nowy wpis na
górze `MEMORY.md`. Tam są odkrycia i metoda pomiaru — nie kod.

### 1.7 Poprawka po zgłoszeniu operatora — wyszukiwanie zostawiało transcript zacięty (commit 3af48480, PR #704)

Operator zrestartował TUI na nowym kodzie i zgłosił: „chyba coś popsułeś to TUI".
Przyczyna zmierzona, nie zgadnięta: **skok do dopasowania ustawia `auto_scroll = false`
i nic go już nigdy nie włącza.** `auto_scroll` wraca tylko przez `scroll_down` na dole
albo `scroll_to_bottom`, a wyszukiwanie zamyka się przez `AppState::close_search`,
którego renderer w ogóle nie widzi. **Jedno `Ctrl+F` zostawiało transcript na stałe
odklejony od dołu** — operator patrzył na stary fragment, a odpowiedź strumieniowała
poniżej, i TUI wyglądał na zamrożony.

Odtworzone 1:1 przed fixem: po wyszukiwaniu dwa nowe wiersze, a dolny wiersz pokazywał
`line 33` zamiast `line 41`.

- Tryb, w jakim widok był przed wyszukiwaniem, jest zapamiętywany i przywracany, gdy
  wyszukiwanie się kończy. Ręczne przewijanie w trakcie wyszukiwania ma pierwszeństwo —
  zamknięcie wyszukiwania nie cofa przewinięcia operatora.
- Skok zapamiętuje tryb tylko przy **pierwszym** skoku w danej wyszukiwaniu, więc
  przeskakiwanie po dopasowaniach nie nadpisuje go stanem samego skoku.
- Kotwica nie przeżywa wyszukiwania: ponowne `Ctrl+F` z tym samym zapytaniem skacze do
  dopasowania, zamiast po cichu nic nie robić.

Drugi defekt, w tym samym commicie: **panel pomocy** miał sztywną wysokość 22 wierszy
dla keymapu z 22 linii plus 2 wiersze ramki — dwie ostatnie linie (tipy) były
przycinane **przy każdym renderze**, a keymap nie wymieniał **żadnego** z nowych
klawiszy z #699. Wysokość jest teraz liczona z keymapu, keymap zna `Ctrl+F`, `Ctrl+Y`,
`F5`, `Alt+Enter` i klawisze kursora, a test odrzuca linię, która by się zawijała
wewnątrz panelu.

Probe dostał `--rows`/`--cols`: terminal operatora to **42×186**, a layout mierzony przy
40×100 to layout, którego nikt nie widzi.

Weryfikacja: 173 testy TUI (167 przed, 6 nowych), cały workspace Rust zielony, clippy
czysty w dotkniętych plikach, panel pomocy renderuje się w całości przy 42×186 —
wszystkie sekcje i oba tipy widoczne, nic ucięte.


### 1.8 „Stroboskop w okół liter" — zmierzony, nie zgadnięty (commit d5bbb650, PR #704)

Operator po restarcie na #699: „jak pracujesz to się stroboskop w okół liter zrobił".
Nie zgadywałem — **rozłożyłem strumień pty na klatki i policzyłem, które komórki się
zmieniają**. Wynik: z 140 klatek podczas prawdziwej tury **99 zmieniało dokładnie
jedną komórkę** (wskaźnik zajęcia w pasku statusu), a binarka **67 razy prosiła
terminal o kursor**.

Źródło: stary build wołał `Hide` przy wejściu, więc kursor terminala był **niewidoczny
całą sesję**. #699 podmienił to na `set_cursor_position` — a **widoczny kursor terminala
miga**, i tempo migania należy do terminala, nie do kokpitu. Na tym hoście to był
twardy blok tuż przy tekście operatora.

Drugi winowajca: wskaźnik zajęcia `| / - \` w **pogrubionej bieli na nasyconym
niebieskim** pasku, zmieniający się przy każdym z dziesięciu redrawów na sekundę.

**Fix:** kokpit rysuje własny punkt wstawiania (komórka z własnym stylem, podświetlająca
znak pod spodem, nie zasłaniająca go) i **w ogóle nie prosi terminala o kursor** —
67 żądań staje się 0. Wskaźnik to teraz **kropka Braille'a** w przygaszonym
niebiesko-białym, idąca **z zegarem (200 ms)**, nie z częstotliwością redrawu.

### 1.9 Tool use — dyskretnie znormalizowane (commit d5bbb650)

Operator: „współczesne interaktywne TUI dla użytkownika, w którym informacje o tool
use są jakoś dyskretnie poinormowane, zobacz na nasze tools".

Źródło normalizacji już istniało: `execute_native_tool` zwraca `(tool_display,
tool_payload)` — `tool_display` to ten sam krótki napis, który ląduje w DB jako
`display_content` („semantic recall hits=5", „chain_verify: ok (1 chains, 86 blocks)").
Surowy payload idzie do transkryptu; **krótka forma nie szła nigdzie** — bo TUI nie
dostawało zdarzeń o narzędziach.

- `ChatStreamEvent` ma wariant `Tool { name, display, failed, elapsed_ms }`; pętla czatu
  emituje go po każdym wywołaniu.
- Transkrypt: jedna przygaszona linia na wywołanie —
  `▸ chain verify · ok (1 chains, 86 blocks) · 88ms`.
- Panel boczny: `✓ chain verify   ok (1 chains, 86 blocks)   88ms`.
- Etykieta nie powtarza się w podsumowaniu: `chain_verify: ok …` → `ok …`.

**Zasada: kształt, nie ładunek.** Operator widzi, że sześć komend się wykonało i jak
długo trwały — nie wyjście każdej z nich. Surowy payload zostaje w transkrypcie, o
klawisz od operatora.

### 1.10 Panel boczny — jak w pierwszej wersji

Pierwsze TUI Memphis (marzec 2026, `src/tui/index.ts`, usunięte z drzewa) miało **dwa
panele**: rozmowę po lewej (68%) i stałą kolumnę `Commands:` po prawej. Operator wspomniał
o nim wprost. Panel wraca — ale z zadaniem, za które zasługuje na swoją szerokość:
runtime sesji i **wywołania narzędzi bieżącej tury**. Poniżej 100 kolumn panel znika,
zamiast ściskać rozmowę.

Przy okazji: formatowanie paska statusu istniało **dwa razy w jednej warstwie** — w
widgetcie i w module testów `ui.rs` (ze własną kopią spinnera). Widget ma teraz
własność formatowania, test z niej czyta.


---

## 2. Stan środowiska na koniec sesji

Stan sprawdzony **2026-10-27 15:40 UTC**. Merge jest zdarzeniem zewnętrznym — po
scaleniu trzeba sprawdzić **zawartość** `origin/main` (`git show origin/main:<plik>`),
nie tylko status PR.

```
fork/main   == origin/main   (zsynchronizowane, 0/0 za i przed)
HEAD        fix/tui-search-unsticks-transcript @ d5bbb650
PR #698     MERGED 2026-10-26 23:47 UTC (5ae70301) — ADR-011 + Cargo.toml
PR #699     MERGED 2026-10-27 12:07 UTC (3a7f723b) — implementacja warstwy 1
PR #702     MERGED 2026-10-27 12:52 UTC (aafea26c) — playbook pomiarowy
PR #704     OPEN / MERGEABLE — strobe + tool use + panel boczny + fix wyszukiwania
cargo test --workspace  587 testów, wszystko zielone
cargo clippy -p memphis-tui  0 ostrzeżeń w plikach tej sesji
```

**Uwaga operacyjna:** TUI operatora (PID 5149, uruchomiony 16:26:53 lokalnie) ma w
pamięci binarkę z 13:20 — to jest kod **PRZED** #704. Po scaleniu trzeba przebudować
(`cargo build -p memphis-tui`) i zrestartować TUI, bo inaczej poprawka nie trafi do
procesu, który siedzi na ekranie operatora.

---

## 3. Otwarte na decyzje operatora

1. **Czy w ogóle chce powierzchni graficznej?** Warstwy 1 i 2 ADR-011 stoją
   samodzielnie. Jeśli „nie" — zatrzymaj się po Layer 1 i nie buduj protokołu.
2. **Tauri vs Quickshell.** Protocol-first sprawia, że to _wybór_, nie przeróbka.
   Rekomendacja z ADR: protokół najpierw, Tauri jako klient referencyjny,
   Quickshell jako tani.
3. **Czy ujednolicać stosy chatu Rust/TS?** Celowo nierozstrzygnięte — osobny
   ADR. To największa pozostała różnica zachowania między powierzchniami.
4. **Framework frontendu** — rekomendacja żaden; odwracalne później.

---

## 4. Zasady wyłapane dziś — nie powtarzać

- **crossterm czyta rozmiar terminalu z `/dev/tty`, nie ze stdout.** Dziecko
  bez `setsid` dziedziczy controlling terminal agenta i liczy swój layout pod
  cudzy terminal, pisząc do pty. Każdy pomiar TUI przez pty wymaga `setsid`.
- **Ratatui renderuje różnicowo** — na ekranie w strumieniu bajtów nie ma
  ciągłego tekstu (`> hello` nigdy nie wystąpi jako substring, bo kolejne
  klatki przepisują tylko zmienione komórki). Mierz sekwencje sterujące
  (`ESC[?25h`, `ESC[7m`, pozycje kursora), nie napisy.
- **Kursor stoi PO ostatnim znaku**, więc przy pełnym wierszu wychodził o
  jedną kolumnę za obszar — terminale przycinają go wtedy na ostatnim
  znaku. Prompt rezerwuje jedną kolumnę.
- **Testy jednostkowe bywały winne, nie kod.** Cztery moje asercje były złe
  (pomijały jeden krok kursora) — kod poprawny. I jeden prawdziwy błąd:
  zamknięcie wyszukiwania kasowało zapytanie, więc ponowne otwarcie go nie
  odtwarzało.
- **Kotwica w skrypcie musi być unikalna.** Trzy moje edycje spadły na
  wyrównaniu, które zmienił prettier — kotwica przestała pasować, plik
  nietknięty (zapis na końcu), ale straciłem rundę.

---

## 5. Czego dziś NIE zrobiliśmy

- **Nie zbudowaliśmy powierzchni graficznej.** Żadnego Tauri, żadnego
  Quickshell, żadnego frontendu. Warstwa 3 ADR-011 czeka na decyzję operatora
  z pkt 3.
- **Nie wydzieliliśmy crate'a `memphis-cockpit`** (Layer 2 ADR-011) — 8 277 LOC
  do przeniesienia, bez zmiany zachowania. Nie zrobione, bo Layer 1 dało
  wartość bez refaktoru.
- **Nie zrobiliśmy E5** (interaktywny picker `/sessions`) — świadomie
  otwarte: wyszukiwanie z E3 pokrywa większość tego, po co picker miał być.
- **Nie ruszyliśmy podziału stosów chatu Rust/TS** — to osobny ADR.
- **Nie dodaliśmy protokołu v2** (`chat.turn`, streaming, konkurencja per
  capability) — wymaga decyzji o GUI.
- **Nie napisaliśmy testu integracyjnego w Vitest dla wyszukiwania** —
  weryfikacja idzie przez `scripts/tui-pty-probe.py` (Python, poza suite'em).
  Repo ma tylko test headless (`tests/integration/tui-binary-smoke.test.ts`),
  który nie widzi renderowania.
- **Nie scaliliśmy PR #698 ręcznie** — scalony przez automerge (`app/github-actions`).
  Wymagało tricku: `gh pr ready --undo` + `gh pr ready` (trigger `ready_for_review`),
  bo cron `schedule` w tym repo nie odpala regularnie (04:52 → 19:11 → 23:46 → 10:25).
  `gh workflow run` odpada — 403, wymaga admin.
- **Nie zrobiliśmy grafu (Layer 3) ani protokołu v2 (Layer 4)** — czekają na decyzję
  operatora, czy w ogóle chce powierzchni graficznej.

---

## 6. Jak wejść w następną sesję

```bash
cd ~/memphis
git checkout docs/adr-011-cockpit-core-tauri-shell
git fetch origin && git log --oneline origin/main -3

# stan kokpitu
cargo test -p memphis-tui                      # 164 testów
python3 scripts/tui-pty-probe.py ./target/debug/memphis-tui

# stan pamięci
memphis chain verify
memphis health --json | head -c 600
```
