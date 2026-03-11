# ITERATION PLAN #1 — Memphis v4

Data: 2026-03-08
Status: Draft v0.1
Cel: dowieźć basic but working product zgodny z blueprintem + charterem.

---

## 8.1 Task breakdown (małe kroki)

### Faza A — Runtime skeleton (E2E minimal)

1. A1: HTTP server bootstrap + `GET /health`
2. A2: Config loader + schema validation (startup fail-fast)
3. A3: Logger init + requestId middleware

### Faza B — Core contracts + orchestration

4. B1: `LLMProvider` contract (final TS implementation)
5. B2: Orchestration service (request -> provider -> response)
6. B3: Unified domain errors + HTTP mapping

### Faza C — Providers (basic)

7. C1: `shared-llm` adapter (minimal generate)
8. C2: `local-fallback` adapter (safe fallback path)
9. C3: Provider health checks endpoint

### Faza D — API v1

10. D1: `POST /v1/chat/generate` with Zod validation
11. D2: Response contract + usage/timing fields
12. D3: Retry/fallback policy wired (max 2 retries)

### Faza E — CLI v0

13. E1: `memphis-v4 health`
14. E2: `memphis-v4 providers:health`
15. E3: `memphis-v4 chat --input ... [--json]`

### Faza F — Storage baseline

16. F1: SQLite bootstrap (db file + migration init)
17. F2: Minimal session repository
18. F3: Persist metadata (requestId/provider/timing)

### Faza G — Quality & release hardening

19. G1: Unit tests for orchestration + errors
20. G2: Integration tests for health/chat/providers
21. G3: CI green gate + README quick verification

---

## 8.2 Kolejność implementacji

Kolejność sztywna (bez przeskoków):
A1 -> A2 -> A3 -> B1 -> B2 -> B3 -> C1 -> C2 -> C3 -> D1 -> D2 -> D3 -> E1 -> E2 -> E3 -> F1 -> F2 -> F3 -> G1 -> G2 -> G3

Zasada: nie zaczynamy kolejnego kroku, dopóki poprzedni nie przejdzie smoke/test/check.

---

## 8.3 Checkpointy i kryteria akceptacji

### Checkpoint CP-1 (po Fazie A)

- `npm run dev` startuje poprawnie
- `GET /health` zwraca 200

### Checkpoint CP-2 (po Fazach B+C)

- działa przynajmniej 1 provider + fallback
- `/v1/providers/health` pokazuje statusy

### Checkpoint CP-3 (po Fazie D)

- `POST /v1/chat/generate` działa E2E
- unified error format zgodny z kontraktem

### Checkpoint CP-4 (po Fazie E+F)

- CLI działa dla 3 komend
- podstawowy zapis metadanych działa

### Checkpoint CP-5 (po Fazie G)

- testy i CI zielone
- produkt „basic but working” gotowy do akceptacji Elathoxu

---

## Definition of ready-to-review

- Wszystkie fazy A-G ukończone
- Brak blockerów krytycznych
- Checklist pre-coding domknięty
- Demonstracja działania (health + generate + fallback + CLI)
