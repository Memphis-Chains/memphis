# Konsolidacja źródeł prawdy web estate

Status: **wykonane 2026-10-09** (kroki 1–4, 6). Krok 5 (`panel-app/`) świadomie
otwarty — decyzja architektoniczna, czeka na operatora.
Autor: Memphis. Powstało z audytu `docs/site/` vs `sites/memphis-v5/`.
Wersja 3 — po wykonaniu, z pomiarem, który unieważnił krok 3 w wersji 2.

## Wynik

|                                   | przed                                  | po                                 |
| --------------------------------- | -------------------------------------- | ---------------------------------- |
| drzewa źródłowe dla memphis-v5.pl | 2 (`docs/site/` + `sites/memphis-v5/`) | **1**                              |
| plików mastera                    | 131                                    | **141**                            |
| backend php w gicie               | **nigdzie**                            | `sites/memphis-v5/api/` (8 plików) |
| `memphis health` vs strona        | 1.13.3 / 13 332                        | zgodne, generowane                 |

`docs/site/` usunięty po pomiarze: **31 plików, 0 różniących się, 0 brakujących**
w masterze. Siedem referencji w kodzie (generator metryk, kontrakt strony,
mutation gate, pre-commit, eslint, knip) przestawionych na master **w tym samym
commicie** — inaczej generator dalej edytowałby plik, który nie jest wdrażany.

## Krok 3 był oparty o nieprawdę

Plan mówił: „exclude musi zniknąć, bo następny pull skasuje to, co krok 1
zabezpieczył". **Zmierzone odwrotnie.** rsync trzyma wykluczone ścieżki po obu
stronach `--delete`:

```
rsync -a --delete --exclude 'api/' remote/ master/
→ master/api/_boot.php nadal istnieje, treść REPO-API (serwer nie nadpisał)
```

Więc `--exclude 'api/'` **nie chroni** `api/` — ono je ** chroni w drugą stronę**:
pull nie nadpisuje kopii z repo wersją serwera. Zostawiam flagę, ale z właściwym
uzasadnieniem (jest w `estate.json` przy `serverOwnedNeverRsync`).

## Czego plan nie przewidział: `--push` nadpisuje `data/`

Zmierzone: `rsync -a master/ remote/` (bez `--delete`) **nadpisuje
`data/site.db`**, gdyby master je miał. Nie ma go — dziś bezpiecznie przez przypadek,
nie przez bramkę. `data/.salt` przetrwał, bo go w masterze nie ma. Dopisane do
`estate.json` jako komentarz przy `serverOwnedNeverRsync`.

## O liczbach: 15 340, nie 15 311

Plan zostawił otwarte „czy 15 311 / 10 to prawdziwe". Zamknięte pomiarem i
generatorem, nie ręczną edycją: `sync-site-metrics` przelicza z `~/.memphis/chains`
z filtrem `_quarantine` i `*.backup-*` → **15 340 bloków / 10 aktywnych łańcuchów**
(rośnie przy każdym wpisie). `memphis health` mówi 15 615, bo liczy inaczej
(backupy + `_quarantine`) — to metoda, nie rozbieżność.

**Kto nie jest w masterze:** `_quarantine`, `*.backup-*`, `panel-app/`, `panel/`,
`docs/` (build), `data/` (sqlite + sól), `.memphis-snapshots/`.

---

# Wersja 2 (plan, przed wykonaniem)

---

## Co zmierzyłem (nie zgadywałem)

### Skala

|        | `docs/site/` | `sites/memphis-v5/` | serwer                           |
| ------ | ------------ | ------------------- | -------------------------------- |
| plików | 31           | 131                 | 17098 (w tym `panel-app/vendor`) |

`docs/site/` to **mniejsza** kopia. `sites/memphis-v5/` ma pełny statyk.

### Pytanie 1: czy `docs/site/api/` jest aktualne?

Zamknięte. **Tak — wszystkie 8 plików identycznych z serwerem**, potwierdzone
`md5sum` liczonym na serwerze i `diff` pusty. mtime na serwerze: 27–28 września,
nic od tego czasu. Backend nie był ruszany od tygodnia.

Moje pierwsze porównanie pokazało „RÓŻNIĄ SIĘ" dla `_boot.php` przy identycznym
rozmiarze — mój błąd: liczyłem md5 z potoku ssh zamiast z pliku. Ten sam rozmiar
plus pusty diff wystarczał, żeby to rozstrzygnąć.

### Pytanie 2: czyje `index.html` jest nowsze?

Zamknięte. **`docs/site/` jest nowsze i poprawniejsze.**

Różnica to 54 linie, wszystkie w treści, żadna w strukturze (h1, section id,
video, og:image, twitter, canonical, JSON-LD, form — identycznie w obu).

Co dokładnie:

|                | master / serwer (32513 B)                            | `docs/site/` (33080 B)                       |
| -------------- | ---------------------------------------------------- | -------------------------------------------- |
| wersja         | v1.13.3                                              | **v1.13.5**                                  |
| bloków         | 13 332                                               | **15 311**                                   |
| łańcuchów      | 12                                                   | **10**                                       |
| narzędzi       | 57 (+3 = 60)                                         | **59 (+3 = 62)**                             |
| podpis metryki | „Runtime generuje je przy każdym załadowaniu strony" | **„odświeżone ręcznie przy zmianie wersji"** |

Wersja w `docs/site/` to ta sama praca, którą zrobiłem dziś na stronie
memphis-v5.pl: usunięte fałszywe twierdzenie o automatycznym generowaniu,
poprawiona wersja, poprawione liczby. Serwer ma starszą wersję.

**Wniosek: `docs/site/index.html` jest kandydatem do publikacji, nie do
usunięcia.** Plan w wersji 1 miał odwrotną kolejność — to poprawka po pomiarze,
nie po przeczuciu.

### Pytanie 3: czy ktoś pracuje nad panelem teraz?

Zamknięte. **Nie.** Żaden plik w `panel-app/app/` ani w `database/migrations/`
nie był dotknięty dzisiaj. `panel-app/.env` ma mtime 2026-04-22. Migracje z
2026-09-27 to ostatnie, panel od dwóch tygodni nietknięty.

`docs/site/index.html` był edytowany o 17:51 — czyli **w tej sesji, ale przez
inną ścieżkę niż ja**. To ta sama równoległa sesja co przy holiskool.

---

## Co znalazłem w kodzie, nie w nazwach

`_boot.php` (220 linii) jest napisane dobrze i świadomie:

- `daily_visitor_hash()` — HMAC-SHA256 z solą **rotowaną co dobę**, więc hash nie
  podąża za człowiekiem. Zero cookies, zero fingerprintingu, zero IP w bazie.
- `require_post()` — sprawdza metodę, **origin**, content-type. Obce origin → 403.
- `rate_limit()` — okno czasowe w SQLite, `Retry-After` w nagłówku.
- `migrate()` — `CREATE TABLE IF NOT EXISTS` przy starcie, schema nie wymaga
  migracji ręcznej.
- `lead.php` — jawna prawda w odpowiedzi: „Potwierdzenie mailem dojdzie po
  uruchomieniu SMTP — na razie zapis jest pewny." Zgadza się z tym, co
  znalazłem wcześniej: `MAIL_MAILER=log`, więc maile nie wychodzą.

To nie jest kod do przepisania. To jest kod do **zabezpieczenia przed zgubieniem**.

---

## Plan

### Krok 1 — zabezpieczyć backend (repo, nic nie wdrażamy)

`docs/site/api/` jest jedyną kopią kodu backendu w całym repo. Jeden `git clean`
i znikają. Pliki identyczne z serwerem, więc przenoszę wersję z `docs/site/`.

```bash
cp -a docs/site/api            sites/memphis-v5/api
cp -a docs/site/data/.htaccess sites/memphis-v5/data/.htaccess
cp -a docs/site/build-video.py sites/memphis-v5/build-video.py
```

**Nie kopiuję `data/site.db` ani `data/.salt`** — dane produkcyjne. Baza ma
69 KB realnych rekordów (leads, visitors, events, downloads).

**Dowód:** `php -l` na każdym z 7 plików PHP.

### Krok 2 — przejąć nowszy `index.html`

`docs/site/index.html` (33080 B, v1.13.5) jest nowszy niż master i niż serwer.
Kopiuję do `sites/memphis-v5/index.html`.

**To zmienia stan produkcji** — strona pokaże prawdziwe 15 311 bloków i 10
łańcuchów zamiast 13 332 i 12. Zgodne z tym, co `memphis health` zgłasza
dzisiaj (15 571 bloków, 12 łańcuchów wliczając `_quarantine` i backup).

**Dla porównania, zmierzone teraz:** `memphis health` → 15 571 bloków,
12 łańcuchów (11 realnych + `_quarantine` + `cases.backup-*`). Wersja
`docs/site/` mówi 15 311 / 10 aktywnych. Nie rozstrzygnięte, które liczby
poprawne — do sprawdzenia przed publikacją, nie po.

**Dlatego krok 2 jest oddzielony od kroku 1 i wymaga zgody.**

### Krok 3 — poprawić `--exclude`

`sites-sync.sh:110` ma `--exclude 'api/'`. Po kroku 1 `api/` jest częścią
mastera, więc exclude musi zniknąć. `data/` zostaje wyłączone — baza i sól nigdy
nie wchodzą do repo.

**Test falsyfikujący:** po zmianie uruchomić `--pull memphis-v5` na odrzuconym
katalogu i potwierdzić, że `api/` przetrwało, a `data/` wciąż jest poza repo.
Bez tego kroku następny pull kasuje to, co krok 1 zabezpieczył.

### Krok 4 — rozstrzygnąć `docs/site/`

Po krokach 1–2 `docs/site/` jest w pełni redundanctny. Dwie ścieżki:

**A — `git rm -r docs/site/`.** Masterem jest `sites/memphis-v5/`.
**B — `git mv` do `docs/archive/site-2026-10-09/`** z notką o masterze.

**Rekomendacja: A.** Nie dla estetyki — bo dwa źródła prawdy dla jednej domeny
to dokładnie ten błąd, który naprawiłem dziś wcześniej. Ale to **Twoja decyzja**:
31 plików w historii gita, i równoległa sesja może jeszcze pisać w `docs/site/`.

### Krok 5 — `panel-app/`: rozstrzygnięte 2026-10-10, czeka na operatora

Szczegóły w [`docs/dev/notes/panel-app-ownership.md`](../docs/dev/notes/panel-app-ownership.md).

Zmierzone na serwerze: 156 MB i 16 910 plików, z czego **149 MB to `vendor/`**.
Własnego kodu jest **82 pliki** (`app/` 56, `resources/` 6, migracje 17, testy 3)
i **zero wersjonowania** — brak `.git`.

Kluczowe: `--exclude 'panel-app/'` chroni przed nadpisaniem przez rsync, ale nie
przed utratą. Historia, diff i możliwość cofnięcia nie istnieją. To nie jest
decyzja architektoniczna — to brak kopii kodu, który sami napisaliśmy,
opisany jako decyzja.

Rekomendacja: osobne **prywatne** repo. Alternatywnie zapas poza webrootem.
Wciąganie do `memphis` odradzam — `.env` z `APP_KEY` i 149 MB historii za pierwszym
pushem.

### Krok 5 (wersja pierwotna) — `panel-app/`: świadomie poza repo

17 098 plików, `vendor/`, `.env`, `storage/logs/`, 60 plików cache widoków.
Panel nie był ruszany od 22 kwietnia (`.env`) i 27 września (migracje).

Wciągnięcie go do `Memphis-Chains/memphis` oznaczałoby:

- publiczne `.env` i `laravel.log` przy pierwszym pushu
- ~180 MB `vendor/` w historii
- `storage/framework/views/*.php` — cache, nie kod

Panel ma własne życie i własny cykl wydań. **Proponuję osobne repo
`Memphis-Chains/panel`** albo pozostawienie poza gitem na zawsze, z tym samym
`.htaccess` i regułą w `estate.json`.

Największa decyzja architektoniczna tego planu. **Nie ruszam bez Twojego słowa.**

### Krok 6 — bramka

`estate.json.serverOwnedNeverRsync` trzyma `api/` i `data/`. Po kroku 3:

- `data/` zostaje
- `api/` **wypada**

`leakscan.py` `SKIP_PREFIXES` zostawia `/api/` — endpointy nie są stronami i nie
powinny być w crawl-ie.

---

## Czego plan nie robi

- **Nie rusza `panel-app/`** — za dużo i to osobna decyzja.
- **Nie wyciąga `data/site.db`** — dane produkcyjne, nie kod.
- **Nie wdraża `api/` na serwer** — krok 1 to kopiowanie do repo.
- **Nie publikuje `index.html` bez Twojego słowa** — krok 2 zmienia to, co
  widzą odwiedzający.
- **Nie rusza palet.**

---

## Kolejność, odwracalność, koszt

| Krok | Co robi                      | Odwracalny                  | Ryzyko                          | Czas       |
| ---- | ---------------------------- | --------------------------- | ------------------------------- | ---------- |
| 1    | backend do repo              | tak (cp, nic nie nadpisuje) | brak                            | 2 min      |
| 2    | nowszy index.html do mastera | tak (git)                   | **zmiana strony — do zgody**    | 1 min      |
| 3    | poprawka exclude             | tak (jedna linia)           | brak                            | 2 min      |
| 4    | usunąć docs/site/            | tak (git rm)                | skasuje pracę równoległej sesji | 1 min      |
| 5    | panel-app                    | decyzja                     | —                               | do decyzji |
| 6    | estate.json                  | tak                         | brak                            | 1 min      |

Kroki 1, 3, 6 to ~5 minut i dotyczą wyłącznie repo. Krok 2 czeka na Twoje
słowo. Kroki 4 i 5 czekają na decyzję.

---

## Czego jeszcze nie wiem

- **Czy 15 311 / 10 to prawdziwe liczby.** `memphis health` mówi 15 571 bloków
  i 12 katalogów łańcuchów. Różnica może być metodą zliczania (backup +
  `_quarantine` nie są aktywnymi łańcuchami). Sprawdzę przed publikacją kroku 2,
  nie po.
- **Czy równoległa sesja skończyła `docs/site/`.** Ostatni zapis 17:51. Jeśli
  pisze dalej, krok 4 skasuje jej pracę.
- **Czy `data/site.db` kiedykolwiek trafiła na GitHub.** Jeśli tak, wyciągnięcie
  jej do repo wymaga oczyszczenia historii, nie tylko gitignore.
