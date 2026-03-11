# TECH SPEC v0 — Memphis v4

Data: 2026-03-08
Status: Draft v0.1

## 2.1 Stack (runtime, framework, package manager)

### Runtime

- Node.js: `v22.x` (LTS line)
- Rust toolchain: `stable` (rustc 1.94.0, cargo 1.94.0)

### Language / Build

- TypeScript (`strict: true`)
- tsx (dev runtime)
- tsc (build/typecheck)

### Package Manager

- npm (aktywnie używany w repo po inicjalizacji)
- Uwaga: można przełączyć na pnpm po wspólnej decyzji, ale na teraz utrzymujemy spójność z obecnym lockfile.

### Baseline dependencies (zainstalowane)

- `typescript`
- `tsx`
- `@types/node`

### Aktualny stan repo

- `src/index.ts` — shell startowy
- `tsconfig.json` — konfiguracja strict
- `package.json` scripts:
  - `dev`: `tsx src/index.ts`
  - `build`: `tsc -p tsconfig.json`
  - `typecheck`: `tsc -p tsconfig.json --noEmit`

---

## Dodatkowe wymaganie (nowe)

Research i ocena bibliotek do integracji z providerami:

- Shared LLM
- Decentralized LLM

Źródło: GitHub-first (utrzymanie, aktywność, licencja, TS support, ergonomia integracji).

## Otwarte decyzje do kolejnych podpunktów

- 2.2 Architektura modułów — domknięte w `ARCHITECTURE_V0.md`
- 2.3 Kontrakt interfejsów (API/CLI)
- 2.4 Strategia konfiguracji
- 2.5 Logging + error handling
