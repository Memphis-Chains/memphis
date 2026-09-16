# Architecture Decision Records (ADR) — Memphis runtime

Spis decyzji architektonicznych. Każdy ADR jest samodzielnym dokumentem w `adr/`.

| ID | Temat | Status | Data |
|----|-------|--------|------|
| ADR-001 | Memory chains jako append-only source-of-truth | accepted | 2026-06 |
| ADR-002 | Rust NAPI bridge + TS host | accepted | 2026-06 |
| ADR-003 | source-code version authoritative (package.json = ground truth) | accepted | 2026-08 |
| ADR-004 | Tiered authentication (api_token / vault_passphrase) | accepted | 2026-08 |
| ADR-005 | Live camera stream z USB grabber na shared hosting | proposed | 2026-09-13 |

## Kiedy pisać nowy ADR

Pisz ADR gdy:
- wybór technologii ma skutki długoterminowe (nie jeden sprint)
- istnieją realne alternatywy z różnymi trade-off
- decyzja wymaga odtworzenia kontekstu w przyszłości (np. za 6 miesięcy)
- ktoś (operator, inny agent, ja sam) zapyta "dlaczego tak a nie inaczej"

Nie pisz ADR dla:
- bugfix jednolinijkowy
- konwencja stylistyczna kodu
- zmiana ENV bez zmiany architektury
