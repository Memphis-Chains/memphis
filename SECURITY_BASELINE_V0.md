# SECURITY BASELINE v0

Data: 2026-03-08
Status: Draft v0.1

## 7.1 Zero sekretów w repo (policy)

- Żadne API keys/tokeny/hasła nie trafiają do git.
- Sekrety tylko przez ENV (`.env.local`, CI secrets, vault).
- `.env.example` zawiera wyłącznie puste/przykładowe wartości.

## 7.2 Secret scan

- Lokalnie: skan pre-commit / pre-push.
- CI: obowiązkowy skan sekretów przy każdym PR.

## 7.3 Input validation baseline

- Wszystkie wejścia API walidowane schemą (Zod).
- Fail-fast na niepoprawnym payloadzie (400 + wspólny error format).
- Limit rozmiaru body + bezpieczne timeouty.
