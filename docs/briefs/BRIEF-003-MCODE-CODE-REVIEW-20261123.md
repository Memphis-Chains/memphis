# BRIEF #003 dla mcode (Mavis) — audyt kodu operatora: 51 commitów, 3 dziury

> **Autor:** Memphis (Memphis runtime)
> **Dla:** mcode (Mavis/MiniMax-M3), subagent kodera Wodzu
> **Data:** 2026-11-23 ~11:00 CEST
> **Powód:** Wodzu kazał „zostaw notkę o tym dla mcode, tak żeby zobaczył".
> To jest notka z audytu JEGO kodu — nie zlecenie pracy. Jeśli uznasz,
> że coś z tej listy powinno zostać zrobione, odpowiedz; jeśli nie, nie ruszaj.

---

## 1. Co było zmierzone

Gałąź `fix/tui-input-sanitize` w `/home/memphis/memphis`:

| Metryka | Wynik |
|---|---|
| Commitów na gałęzi vs `origin/main` | 51 (50 niepushniętych) |
| Plików / linie | 224 pliki, +17991 / −5677 |
| Autor | wszystkie commity: Wodzu (Marcin Kukla) — zero moich |
| Linie src+crates vs tests | 12635 vs 5356 |
| `tsc --noEmit` | clean |
| `cargo test -p memphis-operator` | 341 passed, 0 failed |
| `chain verify` (żywy host) | `ok: true`, 11 865 bloków, 15 łańcuchów |
| `.only` / `.skip` / `TODO` / `@ts-ignore` / `eslint-disable` w diffie | **0** |
| Bramki CI osłabione | Nie — 3 workflows, tylko dodane linie, zero `continue-on-error` |

**WERDYKT: praca jest wybitna.** Każdy commit mierzy, zanim naprawia. Konkretnie
zweryfikowane przykłady z commit message i diffu:

- `f67493c7ca` — usunięcie `src/security/integrity.ts`, czwartej kopii hasza bloku
  z RSA/SHA-256, która deklarowałaby KAŻDY blok na dysku uszkodzonym (udowodnione
  na `chains/collective/000001.json`: dead 659247eb vs canonical 65040d65, MISMATCH).
  Moduł nie miał importu poza własnym testem — zmierzone, nie zgadnięte.
- Rotacja łańcuchów: `system` 15 771 → 500 bloków (62 MB → 0,4 MB), `insights`
  33 MB → 11 MB, 23 MB wróciło na dysk, archiwum odtwarza się w całości
  (297 bloków wczytane, 297 odtworzone, łańcuch po restore się weryfikuje).
- Kontrakt narzędzi: 3 kopie → 1 (48 inline schematów MCP + 52 inline schematów
  executora zniknęło), rozbieżności 40 → 0 dla 64 narzędzi. Rozjazd, który
  gryzł: `memphis_journal` gubił argument `chain` w gatewayu, więc to samo
  wywołanie pisało do dwóch różnych łańcuchów zależnie od powierzchni.
- UTF-8 przez granicę chunka, martwy kod w `ssrf_guard`, panic w Rust nie może
  zabić procesu, `MemoryMax=4G` + `OOMPolicy=kill` w jednostce produkcyjnej
  (zgodne z `scripts/systemd/memphis.service` w repo).

---

## 2. Trzy realne dziury (tu jest wartość tej notki)

### 🔴 Dziura 1 — rotacja nie czyści indeksu embed: 21,4% indeksu wisi na nieistniejących blokach

Zmierzone na `~/.memphis/embed/index-bge-m3-20261106.json` (12 894 chunków):

```
chunki z żywym źródłem:        10133
chunki BEZ źródła na dysku:     2761   (21,4%)
```

Wszystkie 2761 to `insights` — prefix 1–297 zarchiwizowany przez rotację
o 04:09. Efekt: `memphis_recall` na takich trafieniach zwraca
`contentSource: "preview"` zamiast pełnego źródła, czyli dokładnie ta degradacja,
którą decyzja #712 miała zamknąć. W `src/infra/storage/chain-rotation.ts` i
`src/infra/runtime/chain-rotation-loop.ts` nie ma ani jednego `reindex`/`purge`
indeksu — rotacja po cichu psuje pamięć semantyczną.

**Falsyfikator:** po `chain rotate` na łańcuchu z indeksowanymi blokami,
`memphis_recall` na zapytanie z archiwum musi zwrócić `contentSource: "chain"`
albo trafienie musi zniknąć — dziś zwraca `preview`.

### 🔴 Dziura 2 — 659 linii nowego kodu bez ani jednego testu

```
src/infra/runtime/fatal-guard.ts        211 linii   — 0 testów
src/infra/http/public-chain-context.ts   314 linii   — 0 testów
src/infra/http/public-minimax.ts         134 linii   — 0 testów
```

Grep po całym repo (poza `src/`) nie znajduje żadnego pliku testowego, który je
wspomina. Tymczasem `public-minimax.ts` to **publicznie wystawiony** endpoint:
tunel SSH (`scripts/public-chat-tunnel.sh`) → PHP na `lh.pl` → relay. Ma limit 4
równoległych połączeń i walidację schematu, ale **nie ma rate-limitu per IP**,
a `public-chain-context.ts` czyta `journal` w całości (bo niesie consent
annotations). Publiczny czat czytający Twoje łańcuchy to najwyższa ekspozycja
w tej gałęzi i jednocześnie jedyna bez pokrycia testem.

### 🟡 Dziura 3 — 50 commitów istnieje tylko na tym dysku

`origin/fix/tui-input-sanitize` stoi na scalonym PR #769. Wszystko powyżej jest
niepushnięte. Zero PR-y, zero bundle (ostatni bundle: 2026-10-07, `~/private-work/`).
`origin/main` ma przy tym 5 commitów, których ta gałąź nie zawiera → merge
będzie potrzebował rebase'u.

---

## 3. Poza tym: drzewo ma niezacommitowaną pracę

`git status` w `/home/memphis/memphis` — 6 zmodyfikowanych plików + 2 nowe
(`src/core/canonical-json.ts`, `src/core/block-payload.ts`). To trwająca unifikacja
hasha bajt-po-bajcie: Rust pisze klucze w kolejności `BTreeMap`, TS tam, gdzie
wpadł literal — zmierzone 6 248 bloków vs 5 606 w dwóch różnych kolejnościach.
`chain verify` tego nie widzi, bo hashuje wartości, nie bajty.

---

## 4. Co z tym zrobić — decyzja jest Twoja

Nie zlecam. Jeśli chcesz coś podjąć, odpowiedz w formacie poniżej. Jeśli
nie — notka jest, Wodzu zna, nic się nie stało.

Priorytet mojej oceny (każdy punkt niezależny):

1. **Bundle + push 50 commitów** — najtańsze, najwyższy efekt. Praca bez kopii
   zapasowej to największe realne ryzyko w tej gałęzi.
2. **Testy dla `fatal-guard` i public-chat** — szczególnie consent-gate
   (blok z `consent: "exportable"` + tag `public-chat` + `scanContent`) i limit
   per IP na relayu.
3. **Purge/reindex indeksu embed po rotacji** — inaczej rotacja po cichu psuje
   pamięć semantyczną na 21% treści.

---

## 5. Format odpowiedzi

Wklej do `/home/memphis/.minimax/briefs/003-memphis-code-review-reply.md`:

```markdown
# Reply do brief #003 (audyt kodu operatora)

## Co z dziur uważasz za realne
1. embed purge po rotacji — [tak / nie / inaczej, bo...]
2. testy dla public-chat — [tak / nie, bo...]
3. bundle + push — [tak / nie]

## Co byś zrobił inaczej
- ...

## Czego nie zauważyłem
- ...

## Blockery
- ...
```

---

**Notatka, nie zlecenie.** Nie ruszaj gałęzi bez sygnału od Wodzu.

— Memphis
2026-11-23 ~11:00 CEST
