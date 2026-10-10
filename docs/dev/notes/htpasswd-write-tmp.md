# htpasswd-write-tmp.mts — co to jest i czemu go nie usuwam

**Data:** 2026-10-10 · **Autor:** Memphis · **Status:** decyzja operatora, nie moja

## Czym jest

30-liniowy skrypt TS, nie mój — leży w katalogu roboczym od 5 września, nieśledzony.
Czyta sekret `memphis_v5_docs_internal_password` z **vault** i zapisuje jego hash
Apache do `sites/memphis-v5/docs/internal/.htpasswd`, czyli do pliku, który chroni
`/docs/internal/` na memphis-v5.pl.

Robione jest poprawnie i z kontrolą:

- hasło idzie na **stdin** do `openssl passwd -apr1`, więc nie zostaje w `argv`
  (nie widać go w `ps`) ani w historii shella;
- po zapisie skrypt **weryfikuje** hash: musi odtworzyć hasło i odrzucić błędne;
- plik zapisywany jest z `mode: 0o640`.

## Dlaczego wjechał mi do commitów

`git add -A` ciągnie plik nieśledzony do indeksu, a `git commit` bierze **cały indeks**.
Wjechał cztery razy w jednej sesji (10.10). Każdy raz wycofywałem przez
`git restore --staged`, ale to moja pamięć, nie bramka.

**Czy to wyciek?** Nie. Zmierzone:

|                              | stan                                      |
| ---------------------------- | ----------------------------------------- |
| plik na `origin/main`        | **nie ma**                                |
| `.htpasswd` na `origin/main` | **nie ma** (0 trafień w `git ls-tree -r`) |
| `.htpasswd` w `.gitignore`   | **tak**, wzorzec `*.htpasswd` (linia 27)  |
| czy skrypt zawiera hasło     | nie — bierze je z vault w runtime         |

Sekret nie opuścił vaultu i nie trafił do repo. Zagrożenie jest wyłącznie
porządkowe: cudzy plik wraca do indeksu przy każdym `git add -A`.

## Decyzja

**Nie usuwam i nie commituję.** Plik należy do operatora, nie do mnie.

Do wykonania przez operatora, jedno z dwóch:

1. **Usunąć** — jeśli panel/docs internal nie jest już utrzymywany.
   `.htpasswd` zostaje na serwerze i działa; skrypt jest jednorazowy.
2. **Zignorować** — dopisać `htpasswd-write-tmp.mts` do `.gitignore`. Wtedy
   przestanie wracać do indeksu, a plik zostaje do ewentualnego ponownego użycia.

Do czasu decyzji każdy commit w tym repo powinien kończyć się
`git diff --cached --name-only` i sprawdzeniem, czy lista jest dokładnie tym,
co chcemy w nim widzieć.

## Powiązane

- `sites/estate.json` → `serverOwnedNeverRsync` zawiera `memphis-v5/panel-app`
  i `memphis-v5/docs`; oba mają pozostać poza rsyncem.
