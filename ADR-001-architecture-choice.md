# ADR-001 — Architecture Choice

Data: 2026-03-08
Status: Accepted

## Context

Memphis v4 ma dowieźć szybko działający, stabilny produkt bazowy, bez nadmiernej złożoności. Jednocześnie musi pozostać miejsce na integracje Shared/Decentralized LLM.

## Decision

Wybór: **modułowy monolit** z wyraźnymi warstwami (`core`, `modules`, `providers`, `infra`) i adapter pattern dla providerów.

## Consequences

### Plusy

- szybkie wdrożenie MVP,
- prostszy deployment i debugging,
- łatwa rozbudowa providerów bez naruszania core.

### Minusy

- przy dużej skali może wymagać późniejszej dekompozycji,
- ryzyko „monolitu spaghetti” jeśli złamiemy granice modułów.

## Guardrails

- twarde granice odpowiedzialności modułów,
- brak bezpośrednich zależności `core` -> `infra`,
- testy integracyjne providerów przez wspólny kontrakt.
