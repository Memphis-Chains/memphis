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

---

## 2. Stan środowiska na koniec sesji

```
fork/main   769bd2d6 == origin/main   (zsynchronizowane fast-forwardem)
HEAD        docs/adr-011-cockpit-core-tauri-shell @ ed968a87
za upstream behind=0  ahead=5
PR #698     OPEN / MERGEABLE / CLEAN
cargo test --workspace  wszystko zielone
cargo clippy -p memphis-tui  0 ostrzeżeń w plikach tej sesji
```

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
- **Nie scaliliśmy PR #698** — brak uprawnień maintainera.

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
