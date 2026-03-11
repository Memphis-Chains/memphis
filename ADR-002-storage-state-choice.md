# ADR-002 — Storage / State Choice

Data: 2026-03-08
Status: Accepted

## Context

Na etapie v0 potrzebujemy prostego, stabilnego storage, który umożliwia szybkie uruchomienie i lokalny development bez dużego narzutu operacyjnego.

## Decision

Wybór: **SQLite na start** (przez warstwę repository), z przygotowaniem na migrację do PostgreSQL w kolejnym etapie, jeśli wzrośnie skala lub współbieżność.

## Consequences

### Plusy

- szybki start i niski koszt utrzymania,
- prosty setup lokalny,
- dobry fit dla MVP.

### Minusy

- ograniczenia skali i concurrency względem Postgresa,
- konieczność migracji przy wzroście obciążenia.

## Guardrails

- dostęp do danych wyłącznie przez kontrakt repository,
- brak SQL-logic rozsianej po modułach,
- plan migracji utrzymywany jako osobny task po MVP acceptance.
