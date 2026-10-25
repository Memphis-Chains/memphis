# Memphis plan napraw i refaktoru

Plan utworzony 2026-10-12; status wykonania 2026-10-18. Właściciel decyzji produktowych: operator Memphis.

Memphis ma działać na Omarchy jako niezawodny agent do codziennej pracy: uruchamiać się po restarcie, korzystać z MiniMax i pamięci, wykonywać już autoryzowane zadania oraz wyjaśniać rzeczywiste ograniczenia. Ten plan przekłada incydent z vaultem i propozycję diagnostyki sekretów na mierzalny program napraw.

**Aktualny punkt wykonania — 2026-10-18:** cache (S1.5), aliasy (S1.6)
i lokalna redakcja historycznej notatki (S1.8) są odebrane. Dalsze wdrożone
przyrosty obejmują audyt, wallet/H3, błędy HTTP i zapisu, wspólne czytniki oraz
błędy CLI. Ostatni odbiór CLI: 37 testów TS, doctor 47/13/0, TUI OK;
MiniMax dał kolejno 500, 200, 200. Przyczyna pierwszego 500 nieustalona.
Chronione dane zachowane. Nowa redakcja Rust Debug ma 10 regresji i pełny Rust
workspace 475 pass / 0 fail / 2 ignored; jej NAPI/TUI wdrożono po 577 testach TS w 86 plikach.
Dwa starty, doctor/TUI i MiniMax HTTP200 z dokładnym markerem przeszły. S1.4, S1.7 i pełne bramki S1 pozostają otwarte.

Bazowy commit to `10fac3d8`; lokalne przyrosty pozostają bez commita/push.
Podczas Rust testów zmieniło się 50 wpisów indeksu, autor nieustalony; stan
zachowano. Szczegóły wyników i ograniczeń: [EXECUTION.md](EXECUTION.md),
[VALIDATION.md](VALIDATION.md) oraz
[handoff](../../../notes/next-session-memphis-recovery-2026-10-14.md).

**Wynik historyczny z 2026-10-12:** naprawa S0 zakończyła się lokalnie powodzeniem;
`doctor` miał 14 ostrzeżeń, a wymagane kontrole przechodziły. Poniższe wyniki
naprawy dotyczą tego dnia.

## Historyczny wynik naprawy — 2026-10-12

- Przywrócony pepper z lokalnej kopii odszyfrowuje istniejący klucz MiniMax. Vault nie był resetowany.
- `memphis.service` działa, jest włączony na start użytkownika, a linger jest aktywny. Po kontrolowanym restarcie licznik automatycznych restartów wynosił zero.
- Test przez `/v1/chat/generate`, w trybie `provider-only`, zwrócił HTTP 200 i `MEMPHIS_OK` z MiniMax-M3.1-Flash-Preview; pojedynczy pomiar wyniósł 855 ms.
- Natywne `memphis tui --check-only --json` przeszło; pamięć, sesje i vault wskazują ustalone ścieżki.
- `doctor`: 60 kontroli, 46 pass, 14 warn, 0 fail, 0 required failures po utworzeniu brakującego DID.
- Integracja Omarchy obejmuje komendę `omarchy agent`, istniejący skrót, menu wyboru agenta i wpis Memphis w launcherze. Zmiany mieszkają w katalogach użytkownika.
- Utworzono prywatną kopię odzyskiwania obejmującą zgodny zestaw env/vault/tożsamość oraz migawki SQLite. Sprawdzono odszyfrowanie obu wpisów i integralność obu baz.

## Decyzja dotycząca propozycji diagnostyki sekretów

Potrzebne są oba przypadki: **lokalna diagnostyka poświadczenia** i **rzeczywisty test skonfigurowanego providera**. Powinny mieć oddzielne wyniki i wspólną, egzekwowaną politykę. Zgoda na test działającego MiniMax nie wymaga każdorazowego pytania „A czy B”. Eksport sekretu, zmiana providera, zmiana uprawnień i destrukcyjne odzyskiwanie pozostają odrębnymi operacjami.

Nie przyjmujemy obietnic z samego opisu funkcji. Generyczny callback może zwrócić sekret; brak pola `plaintext` nie stanowi bariery. Tier narzędzia, tożsamość użytkownika i autoryzacja operacji to trzy różne rzeczy. Maskowany klucz, jego długość i hash plaintextu nie są potrzebne do odpowiedzi „czy działa”. Szczegóły i kontrakty są w [ARCHITECTURE.md](ARCHITECTURE.md).

## Dokumenty wykonawcze

| Dokument                                                                        | Zawartość                                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [EXECUTION.md](EXECUTION.md)                                                    | Aktualny stan, identyfikatory dowodów i chronologia wdrożeń                  |
| [AUDIT.md](AUDIT.md)                                                            | Potwierdzone ustalenia, dowody w kodzie, hipotezy i granice audytu           |
| [ARCHITECTURE.md](ARCHITECTURE.md)                                              | Docelowe odpowiedzialności, poświadczenia, polityki, kontekst i migracje     |
| [SPRINTS.md](SPRINTS.md)                                                        | Dziesięć sprintów z zadaniami, zależnościami, warunkami odbioru i wycofaniem |
| [VALIDATION.md](VALIDATION.md)                                                  | Macierz testów, wyniki rzeczywiście wykonanych kontroli i bramki wydania     |
| [OPERATIONS.md](OPERATIONS.md)                                                  | Obsługa naprawionej instalacji Omarchy i odzyskiwanie                        |
| [Postmortem](../../postmortems/2026-10-12-omarchy-vault-and-launcher-repair.md) | Przyczyna incydentu, przebieg i działania zapobiegawcze                      |

## Kolejność realizacji

| Sprint | Wynik                                                | Status na 2026-10-18                                                                                                                |
| ------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| S0     | Odzyskana lokalna instalacja Omarchy                 | Odebrana lokalnie; działanie ponownie sprawdzone 17 października                                                                    |
| S1     | Transakcyjny cykl życia vaulta i spójna konfiguracja | W toku, P0: S1.1–S1.3 zaliczone w opisanym zakresie; S1.4 częściowe; S1.5–S1.6 odebrane; S1.8 odebrane; S1.7 i pełny odbiór otwarte |
| S2     | Wspólny kontrakt narzędzi i autoryzacji              | Istnieją zmiany; pełny odbiór V05 otwarty, P0                                                                                       |
| S3     | Diagnostyka poświadczeń i providerów                 | Istnieją zmiany; odbiór V03–V07 po kontrakcie S1/S2, P1                                                                             |
| S4     | Odtwarzalne kopie i jeden harmonogram                | Istnieją zmiany; pełne odtworzenie V08–V09 otwarte, P0                                                                              |
| S5     | Spójne health, doctor i readiness                    | Istnieją zmiany; odbiór V10 po S3/S4, P1                                                                                            |
| S6     | Natywna rozmowa i kontekst                           | Zachować istniejący dorobek; odbiór V12–V13 otwarty, P1                                                                             |
| S7     | Pamięć, indeksy i bezpieczne zapisy                  | Zachować istniejący dorobek; odbiór V11/V14 po S4, P1                                                                               |
| S8     | Instalacja i aktualizacja Omarchy                    | Lokalna integracja działa; pełny odbiór V15 na izolowanym hoście otwarty, P1                                                        |
| S9     | Dowody, dokumentacja i odbiór wydania                | Otwarty; wymagane bramki V01–V15 i okres obserwacji z backupem oraz restartem, P1                                                   |

Preferowana kolejność dla jednego wykonawcy: **S1 → S2 → S4 → S3 → S5 → S6 → S7 → S8 → S9**. Prace S4 zaczynają się od sprawdzenia istniejących kopii, zanim migracje zmienią format danych. Zależności techniczne w SPRINTS są ważniejsze od numeracji.

## Najbliższa dostawa

Wyniki inicjalizacji, audyt i natywne Debug są zabezpieczone oraz wdrożone.
Lokalne przypadki V11 wyboru ścieżek przeszły także z user systemd; poprawka jest
wdrożona. Dalej V01: wspólna ochrona wszystkich writerów dotenv i porównanie
odmów na CLI/MCP/HTTP/TUI z odczytem po restarcie. Następnie pozostały odbiór S1.4
i S1.7 oraz przejście do S2; S1.8 pozostaje lokalnie odebrane.
Konkretny zakres jest w [kolejce S1](SPRINTS.md#s1-completion-queue).
Każda kolejna dostawa przechodzi: fixture → testy i build → porównanie artefaktów
→ lokalne wdrożenie z rollbackiem → kontrole po restarcie → osobny commit
wybranego zakresu. Pełne kryteria pozostają w [macierzy odbioru](VALIDATION.md#acceptance-matrix-for-implementation).

## Zasady wykonania

1. Każdy sprint kończy się działającym przyrostem, dowodami i procedurą wycofania. Checkbox odznaczamy dopiero po bramce odbioru.
2. Ustalamy bazowy commit i właściciela istniejących lokalnych zmian przed pracą nad kodem. Pierwotny audyt: `7c51f1a7`; bieżąca baza: `10fac3d8`, wersja pakietu `1.13.5`, gałąź `fix/embed-persistence-and-chain-parse`. Wcześniejszy indeks zachowujemy; nie commitujemy zbiorczo cudzego lub nieodebranego zakresu.
3. Nie uruchamiamy testów migracji ani rotacji na produkcyjnym vaulcie. Stare indeksy i pamięć pozostają dostępne do czasu potwierdzenia nowego odczytu.
4. Nie podnosimy tierów globalnie, nie wyłączamy sond integralności i nie dodajemy nowych pytań o zgodę do już autoryzowanej pracy.
5. Długie zadania mają przetrwać kompakcję kontekstu. Redukujemy powtórzenia, zachowując cel, dowody, decyzje i oczekujące operacje.
6. Telegram, Matrix, voice, Brave, zewnętrzny MCP i trening są opcjonalne. Brak ich konfiguracji nie jest awarią podstawowego agenta Omarchy.

W zakresie tego incydentu ten plan aktualizuje wcześniejsze [plany napraw](../2026-09-28-repair-plan.md) i [audyt z maja](../../dev/holistic-audit-and-refactor-plan-2026-05-11.md). Nie przypisuje ich historycznych wyników obecnej maszynie i nie zmienia automatycznie generowanych priorytetów ani stanu zdalnych issue.
