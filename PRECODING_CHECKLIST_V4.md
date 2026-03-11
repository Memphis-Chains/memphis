# PRE-CODING CHECKLIST v4

Status: przed rozpoczęciem kodowania feature’ów
Data: 2026-03-08

---

## 1) Project Charter (zakres i cel)

- [x] 1.1 Cel v4 (1-2 zdania)
- [x] 1.2 MVP scope (co wchodzi)
- [x] 1.3 Out-of-scope (czego teraz nie robimy)
- [x] 1.4 Definition of Done dla Etapu 1
  - Referencja: `PROJECT_CHARTER_V4.md`

## 2) Specyfikacja techniczna v0

- [x] 2.1 Stack (runtime, framework, package manager)
  - Referencja: `TECH_SPEC_V0.md`
- [x] 2.2 Architektura modułów
  - Referencja: `ARCHITECTURE_V0.md`
- [x] 2.3 Kontrakt interfejsów (API/CLI)
  - Referencja: `INTERFACES_CONTRACT_V0.md`
- [x] 2.4 Strategia konfiguracji (.env/config)
  - Referencja: `CONFIG_STRATEGY_V0.md`
- [x] 2.5 Logging + error handling (poziomy logów, format)
  - Referencja: `LOGGING_ERROR_POLICY_V0.md`

## 3) Decyzje i ryzyka

- [x] 3.1 Top 5 ryzyk + plan mitigacji
  - Referencja: `RISKS_V0.md`
- [x] 3.2 ADR-001: wybór architektury
  - Referencja: `ADR-001-architecture-choice.md`
- [x] 3.3 ADR-002: wybór storage/state
  - Referencja: `ADR-002-storage-state-choice.md`

## 4) Quality Baseline

- [x] 4.1 Lint + formatter + reguły stylu
- [x] 4.2 Konwencje nazewnictwa plików/modułów
- [x] 4.3 Strategia testów (unit/integration)
- [x] 4.4 Krytyczne ścieżki objęte testami na start
  - Referencja: `QUALITY_BASELINE_V0.md`

## 5) Repo Scaffold (bez feature code)

- [x] 5.1 Struktura katalogów
- [x] 5.2 README.md (quick start)
- [x] 5.3 CONTRIBUTING.md (workflow)
- [x] 5.4 .env.example
- [x] 5.5 .gitignore + scripts (dev/test/lint/build)

## 6) CI Minimal Gate

- [x] 6.1 Pipeline: install → lint → test → build
  - Referencja: `.github/workflows/ci.yml`
- [x] 6.2 Fail-fast na błędach
- [ ] 6.3 Blokada merge przy failed checks
  - Wymaga ustawienia branch protection w GitHub repo (manualnie po stronie repo settings)

## 7) Security Baseline

- [x] 7.1 Zero sekretów w repo (policy)
  - Referencja: `SECURITY_BASELINE_V0.md`
- [x] 7.2 Secret scan (hook lub CI)
  - Referencja: `scripts/secret-scan.sh` + `.github/workflows/ci.yml`
- [x] 7.3 Input validation baseline
  - Referencja: `src/infra/config/request-schemas.ts`

## 8) Plan Iteracji #1

- [x] 8.1 Task breakdown (małe kroki)
- [x] 8.2 Kolejność implementacji
- [x] 8.3 Checkpointy i kryteria akceptacji
  - Referencja: `ITERATION_PLAN_V1.md`

---

## Notatki / decyzje robocze

- (uzupełniamy razem)

## Gate do rozpoczęcia kodowania

Rozpoczynamy kodowanie dopiero, gdy punkty 1-4 są domknięte i 5.1-5.4 gotowe.
