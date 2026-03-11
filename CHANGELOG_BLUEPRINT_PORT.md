# CHANGELOG — Blueprint Port (Primary Zip + Blueprint)

Data: 2026-03-08
Commit: 8663cff

## Scope

Port z głównych artefaktów referencyjnych:

- `MEMPHIS-V4-CODELINE-BLUEPRINT.md`
- `memphis-v4-full.zip` (traktowany jako główna referencja kodowa)

## Wprowadzone moduły (aktywny `src/`)

- `src/providers/index.ts`
- `src/config/index.ts`
- `src/agent/system.ts`
- `src/gateway/server.ts`
- `src/cli/index.ts`

## Integracje narzędziowe / quality gates

- Doinstalowane zależności wymagane przez port:
  - `yaml`
  - `commander`
  - `chalk`
- Utrzymane zielone bramki:
  - lint ✅
  - typecheck ✅
  - tests ✅

## Struktura referencyjna

Dodatkowe pliki z importu utrzymane jako materiał referencyjny / naukowy:

- `reference/blueprint-import/...`

## Uzgodniona zasada

Pozostałe zipy i dokumenty traktujemy jako:

- referencję,
- materiał do nauki/reverse engineeringu,
- bez automatycznego merge do głównej linii.
