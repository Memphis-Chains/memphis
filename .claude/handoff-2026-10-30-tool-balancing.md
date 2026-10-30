# Session Handoff — 2026-10-30 (wyważenie narzędzi, PR #725)

## 0. Czytelnik: kim jesteś

Jesteś Memphis w sesji kokpitu (native TUI, Rust) na hoście operatora: Omarchy 4.0.4-1, Hyprland, 2 rdzenie A4-9120, 15 GiB RAM. Powierzchnia autorytatywna to **natywny kokpit** (`target/debug/memphis-tui`), bramka TS (`memphis serve`) to druga ramię tych samych narzędzi. Repo: `/home/memphis/memphis`, upstream `Memphis-Chains/memphis`, fork `elathoxu-crypto/memphis-fork`.

Ta sesja trwała dwie tury rozdzielone ~18,5 godziną przerwy. W przerwie upstream (organizacja `Memphis-Chains`) włączyła 15 commitów i otworzyła dwa PR-y, z których jeden niósł **moją** zmianę. Pracowałem równolegle z drugą sesją — to ona rozstrzygnęła merge, nie ja.

## 1. Co domknięte w tej sesji

### 1.1 Dziura w ścieżce zapisu — zmierzona, nie opisana

`assert_path_not_secret_material` istniał, ale **nikt go nie wołał** (rustc: *function is never used* + *unused import*). Call site zniknął w pierwszym commicie serii narzędziowej. Zmierzone przez prawdziwe narzędzie, na kodzie który właśnie stał:

```
native_self_modify_refuses_the_segments_the_read_path_refuses
  -> "wrote 6 bytes to /home/memphis/memphis/node_modules/.memphis-write-probe"

native_self_modify_refuses_to_write_through_a_symlink_out_of_the_workspace
  -> zapis przeszedł i wylądował poza workspace
```

Czyli autorytatywna powierzchnia mogła zapisać do `node_modules/`, `.env`, `.git/` i wyjść przez symlink poza `~/memphis` — tam mieszka stan vaultu.

Naprawa: ścieżka zapisu dostała reguły ścieżki odczytu, z jednej listy segmentów w `code_read.rs`. Rozwiązywanie symlinków wymagało własnego spaceru (`realpath_resolving_links`), bo `std::fs::canonicalize` **pada, gdy ostatni komponent nie istnieje** — czyli dokładnie wtedy, gdy zapisujemy nowy plik przez symlink; a `realpath_nearest` rozwiązuje najbliższy *istniejący* przodek, więc link do pliku dopiero tworzonego rozwiązywał się sam do siebie.

### 1.2 Mój własny test wywalał CI w PR #708

`quality-gate` na PR #708 stał czerwony od 2026-10-27 przez **mój** test: probe pisał do `$HOME/memphis`, a w CI `HOME` to świeży tmpdir bez checkoutu.

```
native_code_read_refuses_an_inverted_line_range_without_panicking
  -> write probe file: No such file or directory
```

Drugi test tej samej klasy (mój, z grepa) wskazywał na plik repozytorium — w CI go nie ma, a pattern `pub fn` z `ignoreCase:true` dawał 0 trafień. Wywaliłby się jako następny.

Odtworzone lokalnie: `HOME=$(mktemp -d) RUSTUP_HOME=/home/memphis/.rustup CARGO_HOME=/home/memphis/.cargo cargo test -p memphis-operator --lib`. Po fixie: 265 pass / 0 fail / 1 ignored.

### 1.3 Dlaczego #708 nie dało się scalić — i co to mówi o forku

Log automerge o 06:59 UTC zdradził mechanizm:

```
All 4 required checks are green — merging.
X Pull request #708 is not mergeable: the head branch is not up to date with the base branch.
```

GitHub odmawia merge gałęzi BEHIND. Nowy automerge (PR #724, w main jako `b59cf08c`) dodaje krok `gh api -X PUT .../pulls/N/update-branch` — ale to wymaga prawa zapisu na **repo HEAD**, nie na base. Dla gałęzi z forka to zawsze odmowa. Wniosek: **gałąź z forka nigdy nie przesunie się przez automerge — trzeba ją samemu zmerować z main i wypchnąć.**

### 1.4 Rozstrzygnięcie #708 / #722

Równoległa sesja otworzyła #722 z tą samą zmianą, ale wypchniętą z gałęzi **wewnątrz upstreamu**. Scalony 2026-10-30 13:41:59 UTC jako `00b0828c` — **mój fix jest w main**, razem z moim fixem testu. #708 zamknięte jako duplikat, z dokładnym komentarzem.

### 1.5 PR #725 — gałąź operatora

6 commitów, 20 plików, +2067/−172: obie ramiona `memphis_code_read` (wspólna tabela przypadków jako arbiter, uruchamiana przez test w Rust i w TS), `memphis_web_fetch` (guarda SSRF na natywnej powierzchni, cięcie na granicy znaku, timeout z env, jedna liczba bajtów), ścieżka zapisu z regułami ścieżki odczytu, kokpit startujący natychmiast i odtwarzający transkrypt, testy niezależne od checkoutu.

### 1.6 Restart kokpitu — kolejność ma znaczenie

Wczorajszy restart włączył binarkę sprzed naprawy: proces trzymał stary inode (`/proc/3057/exe` → `(deleted)`), a `nm` na nim vs plik na dysku ujawnił brak nowych symboli. Potwierdzone **na żywej powierzchni**: `memphis_self_modify` zapisał do `node_modules/`. Teraz binarka przebudowana (2026-10-30 15:06:18) i ma 2 symbole write-guard + 39 symboli SSRF.

## 2. Stan środowiska na koniec sesji

- Kokpit: `target/debug/memphis-tui` przebudowany 15:06:18, **działający proces to stary kod** — wymaga restartu.
- Git: `feat/cockpit-usability-layer1` = 6 commitów ahead `origin/main`, 0 behind. `fork/main` zsynchronizowany (0/0).
- PR #725: otwarty, CI w toku.
- Łańcuchy: `chain verify ok:true`, 9 łańcuchów.
- Siatki: `backup/pre-rebase-3-2026-10-30`, `backup/pre-rebase-2-2026-10-30`, `backup/pre-rebase-ci-2026-10-29`.
- Cudza praca w drzewie (nie ruszać, nie commitować): `dashboards/assetto-corsa/` — untracked, 3 błędy eslint (`URL`, `Buffer` nie zdefiniowane).

## 3. Otwarte na decyzje operatora

1. **Scalenie PR #725** — po zielonych checkach automerge powinien sam (nowy trigger `workflow_run`). Jeśli gałąź zostanie BEHIND, trzeba zmerować `origin/main` i wypchnąć ręcznie — automerge tego nie zrobi dla forka.
2. **Zakres grepa/globa** — natywna ramię wyszukuje tylko pod `~/memphis`, TS ma szerszy zakres. Nie domknięte.
3. **Skrypt pilnujący nazw parametrów native'owych** — nazwy w rejestrze (`limit`, `context`, `ignoreCase`, `subcommand`, `args`) przyjęte w `1bb57320`; brak mechanizmu, który pilnuje ich zgodności z TS-em.
4. **Rozbieżność z ramieniem TS przy dotfile'ach** — świadomie otwarta (patrz §5).

## 4. Zasady wyłapane dziś — nie powtarzać

- **Test zależny od checkoutu** to nie jest „test uszkodzony" — to test zależny od środowiska, którego lokalnie nie widzę. Powtórzenie warunków CI lokalnie: świeży `HOME` + `RUSTUP_HOME`/`CARGO_HOME` (bez nich rustup nie znajduje toolchaina i test nawet nie startuje).
- **Restart powierzchni przed buildem włącza stary kod.** `/proc/<pid>/exe` pokazuje `(deleted)`, a `nm` na nim vs plik na dysku mówi wprost, co działa. Dowód na żywej powierzchni: zapis do `node_modules/`, czyli dokładnie to, co naprawa miała zablokować.
- **`git push --force-with-lease` bywa odrzucony mimo zgodnego lease**, gdy remote ma SHA, którego już nie ma lokalnie (po rebase). Rozwiązanie bez przepisywania opublikowanej historii: `git reset --hard <opublikowany SHA>` + `git merge origin/main` + zwykły fast-forward push.
- **Gałąź za upstreamem gubi fixy po cichu** — widoczne jako `BLOCKED`. Sync forka fast-forwardem (po `merge-base --is-ancestor`) odblokowuje. Powtórzone 26.10, 29.10 i 30.10.
- **Dwa PR-y mogą nieść tę samą zmianę** (z forka i z gałęzi wewnątrz upstreamu). Porównanie patchów (`git diff origin/main...pr-708` vs `...pr-722`) mówi o tym wprost, zanim coś zduplikuję w main.
- **`gh api -X PUT .../pulls/N/update-branch` wymaga prawa zapisu na repo HEAD** — dla gałęzi z forka zawsze odmowa.
- **Ścieżka zapisu robi `git add -A` w repo jako „snapshot"** → stage'uje CAŁĄ pracę, w tym cudzą. Po każdym przebiegu testów: `git reset -q`.
- **`cargo fmt` na repo, które nie jest fmt-clean, rozsiewa zmianę** (tu 13 plików, z czego 9 cudzych). Mierz `diff --stat` PO fmt i cofaj pliki, których nie dotykałem.

## 5. Czego NIE zrobiliśmy

- **Nie domknęliśmy rozbieżności z ramieniem TS przy dotfile'ach.** TS odrzuca każdy dotfile na pierwszym poziomie; natywna odrzuca segmenty z jednej listy. Domknięcie odrzucałoby `.claude/handoff-*.md` — czyli ten plik. To decyzja operatora, nie moja.
- **Nie scaliliśmy PR #708 sami** — `permissions.push: false` w upstream. Merge wykonał automerge, a równoległa sesja zamknęła #708 jako duplikat #722.
- **Nie ruszyliśmy cudzego `dashboards/assetto-corsa/`** — untracked, 3 błędy eslint, cudza praca. Jest w drzewie, nie w indeksie, nie w żadnym moim commicie.
- **Nie zrobiliśmy skryptu pilnującego nazw parametrów** i **nie rozszerzyliśmy zakresu grepa/globa** — to osobne decyzje, nie części tej serii.
- **Nie zaktualizowaliśmy ADR-012** o fakcie, że `realpath_resolving_links` zastąpił `realpath_nearest` na ścieżce zapisu.

## 6. Jak wejść w następną sesję

```bash
cd /home/memphis/memphis
git log --oneline origin/main..feat/cockpit-usability-layer1   # 6 commitów
gh pr view 725 --repo Memphis-Chains/memphis                    # stan PR
cargo build -p memphis-tui && <restart kokpitu>                # build PRZED restartem
```

Jeśli gałąź zostanie BEHIND: `git fetch origin && git merge origin/main && git push fork feat/cockpit-usability-layer1:feat/cockpit-usability-layer1` (bez force).

Stan tej sesji jest też w łańcuchach: `journal-96`, `journal-97`, `journal-98`, decyzje `tui-1793295512305`, `tui-1793298592505`, `tui-1793369290025`.
