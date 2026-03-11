# REVIEW PACK v1 — Memphis v4 (Basic but Working)

Data: 2026-03-08
Status: Ready for Elathoxu Acceptance Review

## 1) Co zostało dowiezione

### API

- `GET /health`
- `GET /v1/providers/health`
- `POST /v1/chat/generate`

### CLI

- `health`
- `providers:health`
- `chat --input "..." [--provider ...] [--model ...] [--json]`

### Runtime/Quality/Security

- Config fail-fast (Zod)
- Unified error handling + HTTP mapping
- Retry + fallback (`local-fallback`)
- SQLite bootstrap + migrations
- Session repository + generation metadata persistence
- CI workflow (typecheck/lint/test/build + secret scan)
- Release smoke/checklist

## 2) Kluczowe artefakty

- Progress: `IMPLEMENTATION_PROGRESS.md`
- Charter: `PROJECT_CHARTER_V4.md`
- Tech spec: `TECH_SPEC_V0.md`
- Architecture: `ARCHITECTURE_V0.md`
- Interfaces: `INTERFACES_CONTRACT_V0.md`
- Security baseline: `SECURITY_BASELINE_V0.md`
- Release checklist: `docs/RELEASE-CHECKLIST.md`

## 3) Jak uruchomić demo lokalnie

```bash
cd /home/memphis_ai_brain_on_chain/memphis-v4
npm install
cp .env.example .env
```

Ustaw (minimum):

- `DEFAULT_PROVIDER=local-fallback`
- `DATABASE_URL=file:./data/memphis-v4.db`

Uruchom app:

```bash
npm run dev
```

### Smoke API

```bash
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/v1/providers/health
curl -s -X POST http://127.0.0.1:3000/v1/chat/generate \
  -H 'content-type: application/json' \
  -d '{"input":"hello","provider":"auto","sessionId":"sess-review-1"}'
```

### Smoke CLI

```bash
npm run cli -- health --json
npm run cli -- providers:health --json
npm run cli -- chat --input "hello from cli" --json
```

### Full quality gate

```bash
npm run release:smoke
```

## 4) Definicja akceptacji (propozycja)

1. API smoke przechodzi (3 endpointy)
2. CLI smoke przechodzi (3 komendy)
3. `npm run release:smoke` = PASS
4. Potwierdzenie: basic but working spełnia oczekiwania etapu 1

## 5) Otwarte rzeczy (po akceptacji)

- GitHub branch protection (manual repo setting)
- Rozbudowa providerów shared/decentralized wg blueprint
- Kolejny sprint: hardening + feature expansion
