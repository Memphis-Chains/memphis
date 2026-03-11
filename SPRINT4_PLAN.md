# SPRINT 4 PLAN — Memphis v4 Productization

Data startu: 2026-03-08
Baseline: `v4-sprint3-ready`

## Cel sprintu

Podnieść Memphis v4 z poziomu „działa” do „gotowe do codziennego użytku operacyjnego”.

## Kolejność (bez przeskoków)

1. **S4.1 Auth hardening**
   - Spójna polityka auth API/Gateway
   - Jasne zasady endpointów public/private

2. **S4.2 Rate limits + abuse guard**
   - Limity requestów dla endpointów wrażliwych (`chat`, `exec`, gateway chat)
   - Wspólny kontrakt błędu rate limit

3. **S4.3 Config profiles**
   - Profile `development` i `production`
   - Bezpieczne defaulty produkcyjne

4. **S4.4 Operator UX**
   - Rozszerzony health summary (`green/yellow/red`)
   - Go-live checklist v1

5. **S4.5 Acceptance Gate**
   - lint/typecheck/test/build/secret-scan
   - changelog + checkpoint tag
