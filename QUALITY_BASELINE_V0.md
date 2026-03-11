# QUALITY BASELINE v0

Data: 2026-03-08
Status: Draft v0.1

## 4.1 Lint + formatter + styl

- ESLint + TypeScript rules (strict, no-unused-vars, no-explicit-any [warn->error po MVP]).
- Prettier jako single source of formatting.
- Pre-commit: `typecheck + lint` (opcjonalnie na start), obowiązkowo w CI.

## 4.2 Konwencje nazewnictwa

- Pliki: `kebab-case.ts`
- Klasy/typy: `PascalCase`
- Funkcje/zmienne: `camelCase`
- Stałe globalne: `UPPER_SNAKE_CASE`
- Interfejsy kontraktów w `core/contracts/*`.

## 4.3 Strategia testów

- Unit: logika domenowa (`core`, `modules`).
- Integration: adaptery providerów + kluczowe endpointy API.
- Test runner: Vitest.
- Coverage target (MVP):
  - krytyczne ścieżki: 80%+
  - globalnie: pragmatycznie, bez sztucznego nabijania.

## 4.4 Krytyczne ścieżki na start

1. `GET /health` zwraca poprawny status.
2. `POST /v1/chat/generate` waliduje input i zwraca output.
3. Fallback providera działa, gdy primary timeout/fail.
4. Błędy zwracają wspólny format (`error.code`, `message`, `requestId`).
5. Konfiguracja fail-fast przy braku wymaganych kluczy.

## Gate jakości

Żaden merge do main bez przejścia: `typecheck`, `lint`, `test`.
