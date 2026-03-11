# SPRINT 3 PLAN — Memphis v4

Data startu: 2026-03-08
Baseline: `v4-sprint2-ready`

## Cel sprintu

Business-ready workflows: spójna ścieżka Ask → Persist → Recall + czytelne API sesji.

## Kolejność (bez przeskoków)

1. **S3.1 Workflow Ask → Persist → Recall**
   - Dodać endpoint recall po `sessionId`
   - Zweryfikować pełną ścieżkę: chat generate zapisuje event, recall zwraca historię

2. **S3.2 Session APIs v1**
   - Lista sesji
   - Podgląd eventów sesji

3. **S3.3 Provider failover policy v2**
   - Cooldown dla niestabilnych providerów
   - Preferencja zdrowych providerów

4. **S3.4 Ops status endpoint**
   - runtime status: providers health + metrics + uptime

5. **S3.5 Acceptance Gate**
   - lint/typecheck/test/build/secret-scan
   - changelog + tag sprintowy
