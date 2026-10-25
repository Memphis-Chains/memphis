# Obsługa Memphis na Omarchy po naprawie

Stan lokalny z 2026-10-12. Memphis używa MiniMax-M3.1-Flash-Preview, lokalnego Ollama do embeddingów i ma dostępny model Cogito do lokalnej generacji. API słucha na `127.0.0.1:3000`. Kanały bez skonfigurowanych poświadczeń pozostają opcjonalne.

## Uruchamianie i kontrola

| Potrzeba                               | Polecenie lub wejście                                      |
| -------------------------------------- | ---------------------------------------------------------- |
| Agent w terminalu Omarchy              | `omarchy agent`                                            |
| Agent w bieżącym terminalu             | `omarchy agent --inline`                                   |
| Bezpośrednio TUI Memphis               | `memphis tui`                                              |
| Skrót istniejącej konfiguracji         | `Super+Shift+Ctrl+A`                                       |
| Launcher aplikacji                     | Wpis `Memphis`                                             |
| Ustawienia domyślnego agenta           | Menu Omarchy → Setup → Default → Agent → Memphis           |
| Stan usługi                            | `systemctl --user status memphis.service --no-pager`       |
| Restart po zmianie zimnej konfiguracji | `systemctl --user restart memphis.service`                 |
| Log startu                             | `journalctl --user -u memphis.service -b -n 60 --no-pager` |
| Kontrole instalacji                    | `memphis doctor --json`                                    |
| Test natywnego widoku                  | `memphis tui --check-only --json`                          |

Service ma włączony start i linger. Zweryfikowano restart procesu, bez restartowania całego komputera w tej sesji. Bieżący shell Omarchy otrzymał poprawiony PATH; nowe sesje mają konfigurację UWSM i Hyprland.

## Pliki instalacji

| Element                          | Lokalizacja                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| Źródła i kompilacja              | `~/memphis`                                                                              |
| Konfiguracja z sekretami         | `~/memphis/.env`, tryb 0600                                                              |
| Dane i chains                    | `~/.memphis`                                                                             |
| Główna baza sesji i exact search | `~/memphis/data/memphis.db`                                                              |
| Queue WAL i audyt bezpieczeństwa | `~/memphis/data/queue.wal`, `~/memphis/data/security-audit.jsonl`                        |
| Vault                            | `~/.memphis/vault-state.json`, `~/.memphis/vault-entries.json`                           |
| Publiczna tożsamość              | `~/.memphis/did.json`; prywatny seed w vaulcie                                           |
| Launcher CLI                     | `~/.local/bin/memphis`                                                                   |
| Adaptery Omarchy                 | `~/.local/share/omarchy-agent-shim/{omarchy,omarchy-agent,omarchy-default-agent}`        |
| Odnośniki dla shelli             | `~/.local/bin/{omarchy,omarchy-agent,omarchy-default-agent}`                             |
| Wpis aplikacji                   | `~/.local/share/applications/org.memphis.Memphis.desktop`                                |
| Jednostka i lokalny override     | `~/.config/systemd/user/memphis.service`, `memphis.service.d/10-local-runtime.conf`      |
| Integracja sesji                 | `~/.config/uwsm/env.d/50-memphis-agent.conf`, `~/.config/hypr/bindings.lua`, `~/.bashrc` |
| Menu                             | `~/.config/omarchy/extensions/omarchy-menu.jsonc`                                        |

Ścieżki DB, kolejki, audytu i vaulta są jawne w env. Historycznej `~/data/memphis.db` nie scalono ani nie usunięto. Przed ewentualną migracją trzeba porównać jej rekordy z aktywną bazą.

## Obsługa vaulta

Zmiana wartości `MEMPHIS_VAULT_PEPPER` zwykłym edytorem nie jest rotacją. Incydent pokazał, że proces może pozostać sprawny dzięki pamięci podręcznej, a następny start straci dostęp do sekretów.

Przy problemie z odszyfrowaniem najpierw sprawdź zgodność ścieżek i konfiguracji oraz dostępne kopie. Używaj dedykowanego mechanizmu rotacji po przygotowaniu zgodnego zestawu odzyskiwania. Nie uruchamiaj ponownie `vault init` jako ogólnego sposobu naprawienia ostrzeżenia ani nie omijaj sond integralności. Nie wklejaj peppera lub kluczy do zgłoszeń i logów.

## Kopie i odzyskiwanie

Codzienny job `builtin-scheduled-backup` jest aktywny o **02:00 Europe/Warsaw**. Potwierdzono udany przebieg i checksum archiwum. Obecne pole `backups.enabled` w health opisuje osobną pętlę i może wskazywać false mimo aktywnego crona; nie uruchamiaj drugiego harmonogramu tylko po to, aby zmienić to pole. Naprawa tej rozbieżności należy do S4/S5.

Zestawy utworzone podczas pracy:

- `~/.memphis/backups/omarchy-repair-2026-10-11T21-46-40-370Z/` — pliki sprzed naprawy; zawierają również **błędną wcześniejszą konfigurację**. Przydatne do selektywnego wycofania integracji.
- `~/.memphis/backups/omarchy-recovery-20261012T102232Z/` — prywatny, zgodny zestaw po naprawie: `runtime.env`, vault state/entries, DID, operator config, migawki `memphis.db` i `case-index.sqlite`, manifest checksum. Katalog 0700, pliki 0600.
- `~/.memphis/backups/omarchy-repair-2026-10-12-12-22.tar.gz` — dodatkowe standardowe archiwum danych po naprawie, z potwierdzonym checksum.

Standardowy backup **pomija vault** i nie obejmuje automatycznie głównej bazy znajdującej się poza `~/.memphis`. Prywatny zestaw uzupełnia te braki dla tej instalacji. Jest lokalną kopią na tym samym dysku, nie zabezpieczeniem przed utratą całego dysku. Nie publikuj ani nie wysyłaj go jako zwykłego załącznika diagnostycznego.

Procedura odzyskiwania wymaga konkretnego wyboru zestawu i zakresu:

1. Zachowaj bieżący stan i zatrzymaj usługę oraz procesy TUI, które mogą pisać.
2. Zweryfikuj manifesty/checksum i odtwórz wybrany zestaw do osobnego katalogu.
3. Sprawdź SQLite, chains, zgodność konfiguracji z vaultem i publicznej tożsamości z seedem. Weryfikację sekretów wykonuj bez ich wypisywania.
4. Przygotuj dokładne mapowanie plików ze stagingu na aktywne ścieżki i możliwość wycofania. `runtime.env` odpowiada repozytoryjnemu `.env`; `operator.json` trafia do `~/.memphis/config/`.
5. Dopiero po weryfikacji podmień wymagane pliki, utrzymaj prywatne uprawnienia i uruchom usługę. Nie mieszaj starego peppera z innym vault-state.
6. Sprawdź health, doctor, native TUI i dozwolony test providera. Zachowaj poprzednią generację do zakończenia odbioru.

Pełnego odtworzenia działającego hosta nie wykonano w tej sesji. Zweryfikowano skopiowane bazy i odszyfrowanie credentiali; S4 dodaje automatyczny, kompletny drill.

## Wycofanie integracji Omarchy

Przywróć selektywnie pliki użytkownika z kopii sprzed zmian i usuń wyłącznie nowe pliki/odnośniki należące do tej integracji. Nie przywracaj całego starego env. Po zmianie jednostek wykonaj `systemctl --user daemon-reload`; po zmianach Hyprland `hyprctl reload` i `hyprctl configerrors`. Przywrócenie PATH shella wymaga ponownego uruchomienia shella lub nowej sesji.

Aktualizacje Omarchy nie powinny nadpisywać tych plików, ponieważ nie zmieniano `/usr/share/omarchy` ani `/usr/bin`. Zmiana kontraktu poleceń w przyszłej wersji pakietu może wymagać dostosowania adapterów; S8 ma zapewnić wykrywanie i testy takiej niezgodności.
