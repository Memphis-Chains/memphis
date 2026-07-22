# Memphis

[![CI](https://github.com/Memphis-Chains/memphis/actions/workflows/ci.yml/badge.svg)](https://github.com/Memphis-Chains/memphis/actions/workflows/ci.yml)
[![Licencja: Apache-2.0](https://img.shields.io/badge/license-Apache%202.0-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933)](https://nodejs.org)
[![Rust](https://img.shields.io/badge/rust-stable-orange)](https://www.rust-lang.org)
[![Strona](https://img.shields.io/badge/website-memphis--v5.pl-ff6b35)](https://memphis-v5.pl)

[English](./README.md) · Polski

**Suwerenna AI działająca na Twoim komputerze, pamiętająca w łańcuchach, które należą do Ciebie.**

Memphis jest lokalnym runtime'em agenta poznawczego, powstałym z ruchu [Oswobodzeni](https://oswobodzeni.pl). Pamięć zapisuje w dołączanych blokach połączonych SHA-256, dane uwierzytelniające chroni lokalnie, a działania wrażliwe zabezpiecza poziomami autoryzacji.

To nie jest wyłącznie interfejs czatu. Memphis łączy pamięć, narzędzia, modele lokalne i chmurowe oraz powierzchnie operatorskie w runtime, nad którym kontrolę zachowuje użytkownik.

**Wersja:** `v1.11.0` · **Status:** runtime nadzorowany przez operatora · [historia zmian](./CHANGELOG.md)

**Powierzchnie publiczne:** [strona](https://memphis-v5.pl) · [start](https://memphis-v5.pl/start/) · [dokumentacja](https://memphis-v5.pl/docs/) · [roadmapa](https://memphis-v5.pl/roadmap/) · [llms.txt](https://memphis-v5.pl/llms.txt) · [agents.json](https://memphis-v5.pl/agents.json)

> Pełna dokumentacja techniczna pozostaje po angielsku w [`README.md`](./README.md) i katalogu [`docs/`](./docs/). Ten dokument jest polskim, utrzymywanym skrótem ścieżki operatorskiej.

---

## Instalacja

Linux, macOS lub WSL2:

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash
```

Instalator przygotowuje zależności, kod, lokalną konfigurację i scaffold profilu operatora. Nie kopiuje cudzej tożsamości ani sekretów. Każdy operator inicjalizuje własny vault, tożsamość i pierwsze łańcuchy podczas `memphis init`:

```bash
memphis init
memphis doctor
memphis service install
memphis service restart
memphis tui
```

Możesz połączyć instalację z interaktywnym pierwszym uruchomieniem:

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash -s -- --with-init
```

Na macOS uruchamiaj runtime w terminalu przez `npm run dev` albo skonfiguruj `launchd`; komendy `memphis init`, `memphis doctor` i `memphis tui` działają tak samo jak na Linuksie.

Jeśli po instalacji powłoka nie widzi komendy `memphis`, wykonaj `hash -r`, sprawdź `which memphis`, a w checkoutcie źródłowym ponów `npm link`.

Szczegółowa instrukcja dla nowej osoby: [`docs/operator/install-fresh-user.pl.md`](./docs/operator/install-fresh-user.pl.md).

---

## Co dostajesz

- **Pamięć łańcuchowa** — 11 kanonicznych append-only chains: journal, decisions, reflections, cases, patterns, system, collective, proactive, insights, soul i messages.
- **Integralność danych** — bloki są domyślnie połączone SHA-256; podpisy Ed25519 można wymusić przez `RUST_CHAIN_REQUIRE_SIGNATURES=true`.
- **Szyfrowany vault** — AES-256-GCM i Argon2id dla kluczy providerów oraz danych uwierzytelniających integracji.
- **Pięć trybów poznawczych** — A: Capture, B: Inference, C: Prediction, D: Collective, E: Meta-Reflection.
- **Natywny TUI w Ruście** — główny kokpit operatora dla rozmów, pamięci, sesji, vaultu, cases i diagnostyki.
- **Niezależność od dostawcy** — żądany lub domyślny provider jest sprawdzany jako pierwszy, a błędy możliwe do ponowienia przechodzą przez konfigurowalną kaskadę zakończoną przez local-fallback. Dostępne rodziny obejmują Ollama, Anthropic, MiniMax, DeepSeek i GLM.
- **Powierzchnie integracyjne** — CLI, HTTP API, MCP i opcjonalny gateway Telegram.
- **Kartograf ONNX** — lokalne embeddings i routing stref, ładowane na żądanie.
- **Skills** — tworzenie, walidacja, instalacja i kompozycja procedur agenta.
- **Kontrolowana ewolucja** — zmiany kodu przechodzą przez snapshot Git, branch, testy i zgodę operatora.

Memphis nie wysyła telemetrii ani analityki. Ruch sieciowy pojawia się wyłącznie wtedy, gdy operator skonfiguruje zewnętrznego providera lub integrację.

---

## Pierwsze kroki

```bash
memphis health --json
memphis providers list
memphis provider add anthropic
memphis setup telegram --bot-token <token> --allowed-user-ids <csv>
memphis search --query "czego szukasz"
memphis chain verify
memphis tui
```

Klucze providerów i Telegrama trafiają do vaultu, nie do repozytorium. Plik `.env` służy do konfiguracji, odwołań do vaultu oraz dwóch lokalnie generowanych sekretów bootstrapu: `MEMPHIS_API_TOKEN` i `MEMPHIS_VAULT_PEPPER`. Zarówno vault, jak i `.env` są wykluczone z Git.

### Najważniejsze komendy

| Cel                   | Komenda                            |
| --------------------- | ---------------------------------- |
| Pierwsze uruchomienie | `memphis init`                     |
| Stan runtime          | `memphis health`                   |
| Głęboka diagnostyka   | `memphis doctor --deep`            |
| Kokpit operatora      | `memphis tui`                      |
| Lista providerów      | `memphis providers list`           |
| Dodanie providera     | `memphis provider add <nazwa>`     |
| Lista sekretów        | `memphis vault list`               |
| Dodanie sekretu       | `memphis vault add <klucz>`        |
| Wyszukiwanie pamięci  | `memphis search --query "<fraza>"` |
| Weryfikacja łańcuchów | `memphis chain verify`             |
| Status usługi         | `memphis service status`           |

Pełną powierzchnię pokaże `memphis --help`.

---

## Granice zaufania

| Poziom | Wymagane uwierzytelnienie | Przykładowy zakres                                              |
| ------ | ------------------------- | --------------------------------------------------------------- |
| Tier 0 | brak                      | zdrowie, odczyt pamięci, zapytania do cases                     |
| Tier 1 | token API                 | konfiguracja runtime i operacje na sekretach                    |
| Tier 2 | hasło vaultu              | modyfikacja źródeł, instalacja narzędzi i operacje na branchach |

Vault, `.env`, lokalna baza, łańcuchy, modele i profil operatora są ignorowane przez Git. Nowy clone zawiera kod oraz przykłady konfiguracji, ale nie zawiera danych ani tożsamości autora repozytorium. Narzędzia należą do tierów 0–2; tier 3 jest czasową sesją uprawnień odblokowywaną hasłem operatora, a nie dodatkową klasą narzędzi.

---

## Budowanie ze źródeł

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
npm run bootstrap
memphis init
memphis doctor
```

Kontrola jakości dla contributorów:

```bash
npm run lint
npm run typecheck
npm run format:check
npm run test:ts
npm run test:rust
```

---

## Dokumentacja

- [Onboarding](./ONBOARDING.md)
- [Instrukcja nowego użytkownika po polsku](./docs/operator/install-fresh-user.pl.md)
- [Podręcznik operatora](./docs/operator/operator-handbook.md)
- [Rozwiązywanie problemów](./docs/operator/TROUBLESHOOTING.md)
- [Architektura kanoniczna](./docs/dev/CANONICAL-ARCHITECTURE.md)
- [Bezpieczeństwo](./docs/dev/SECURITY-GUIDE.md)
- [Proces wydań](./docs/dev/RELEASE-PROCESS.md)

## Współpraca i licencja

Zgłoszenia i pull requesty są mile widziane. Zobacz [`CONTRIBUTING.md`](./CONTRIBUTING.md).

Memphis jest udostępniany na licencji Apache 2.0 — zobacz [`LICENSE`](./LICENSE).
