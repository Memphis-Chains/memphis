# RISKS v0 — Top 5 + Mitigation

Data: 2026-03-08
Status: Draft v0.1

## R1) Niestabilność providerów (shared/decentralized)

**Ryzyko:** różna dostępność, timeouty, niestabilne API.
**Wpływ:** przestoje lub niska jakość odpowiedzi.
**Mitigation:**

- adapter abstraction + fallback provider,
- health checks per provider,
- retry policy (max 2) + timeouty,
- monitoring błędów per provider.

## R2) Scope creep przez „cały blueprint”

**Ryzyko:** rozrost zakresu i utrata tempa dowiezienia MVP.
**Wpływ:** opóźnienia, niedomknięty produkt.
**Mitigation:**

- „basic but working first” jako twarda zasada,
- etapowanie: MVP -> rozszerzenia,
- każda nowa rzecz: decyzja czy MVP czy backlog.

## R3) Niezgodność kontraktów API/CLI przy iteracjach

**Ryzyko:** breaking changes podczas rozbudowy.
**Wpływ:** regresje i koszt utrzymania.
**Mitigation:**

- wersjonowanie `/v1`,
- testy kontraktowe,
- zmiany breaking tylko przez `/v2`.

## R4) Błędy konfiguracji/secrets

**Ryzyko:** brak kluczy, wyciek sekretów, nieprzewidywalny start.
**Wpływ:** awarie i ryzyko bezpieczeństwa.
**Mitigation:**

- fail-fast config validation (Zod),
- `.env.example` + policy zero secrets in repo,
- maskowanie sekretów w logach,
- secret scan w CI.

## R5) Nadmierna złożoność architektury na starcie

**Ryzyko:** overengineering przed realnym usage.
**Wpływ:** wolne tempo i większa awaryjność.
**Mitigation:**

- modułowy monolit na v0,
- minimalny zestaw komponentów,
- decyzje o rozbudowie dopiero po metrykach i feedbacku.
