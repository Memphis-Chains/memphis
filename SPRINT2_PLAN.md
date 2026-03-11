# SPRINT 2 PLAN — Memphis v4

Data startu: 2026-03-08
Baseline: `v4-blueprint-port-1`
Źródła prawdy: `PRIMARY_SOURCES.md`

## Cel sprintu

Przejść z „basic but working” do „operationally ready”, utrzymując pełną zgodność z blueprintem i clean quality gate.

## Kolejność (bez przeskoków)

1. **CLI Unification (S2.1)**
   - Ustalić jedną kanoniczną ścieżkę CLI (`src/infra/cli/index.ts` vs `src/cli/index.ts`)
   - Usunąć duplikację odpowiedzialności
   - Zachować kompatybilność komend `health/providers:health/chat`

2. **Gateway Integration (S2.2)**
   - Spiąć `src/gateway/server.ts` z obecnym kontenerem app
   - Ujednolicić auth + error contract
   - Dodać testy integracyjne endpointów gateway

3. **Provider Runtime Policy (S2.3)**
   - Ujednolicić konfigurację providerów (config + env)
   - Włączyć kontrolowany fallback policy dla shared/decentralized
   - Dodać smoke na przełączanie providerów

4. **Observability + Ops (S2.4)**
   - requestId propagation end-to-end
   - metryki podstawowe (latency, provider success/fail)
   - runbook aktualizacje pod nowy runtime

5. **Acceptance Gate S2 (S2.5)**
   - release:smoke
   - pełny test pass
   - changelog i checkpoint tag

## Definition of Done (Sprint 2)

- Brak duplikatów krytycznych modułów
- Jeden spójny przepływ: CLI/API/Gateway -> Orchestrator -> Providers -> Storage
- Zielony quality gate (lint/typecheck/test/build/secret-scan)
- Dokumentacja zaktualizowana
