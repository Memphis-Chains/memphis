# Memphis v5 Quick Start (5 Minutes)

## 1) 5-minute setup

```bash
git clone https://github.com/Memphis-Chains/memphis-v5.git
cd memphis-v5
./scripts/install.sh
memphis health
```

If health is OK, you are ready.

Optional initial checks:
```bash
npm run -s cli -- doctor --json
```

---

## 2) First Steps Tutorial

## Step 1: Start HTTP server (if your workflow uses API)
Use your existing runtime launcher/process manager, then validate:

```bash
curl -s http://127.0.0.1:3000/health
```

## Step 2: Generate first response
```bash
curl -s http://127.0.0.1:3000/v1/chat/generate \
  -H "Authorization: Bearer $MEMPHIS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":"Hello Memphis","provider":"auto"}'
```

## Step 3: Initialize vault
```bash
curl -s http://127.0.0.1:3000/v1/vault/init \
  -H "Authorization: Bearer $MEMPHIS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"passphrase":"my-strong-passphrase","recovery_question":"Pet?","recovery_answer":"Milo"}'
```

## Step 4: Save first journal block
```bash
curl -s http://127.0.0.1:3000/api/journal \
  -H "Authorization: Bearer $MEMPHIS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"First Memphis journal entry","tags":["onboarding"]}'
```

## Step 5: Recall context
```bash
curl -s http://127.0.0.1:3000/api/recall \
  -H "Authorization: Bearer $MEMPHIS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"onboarding","limit":5}'
```

---

## 3) Common Use Cases (5 Examples)

1. **Daily AI memory journal**
   - Write with `/api/journal`, retrieve with `/api/recall`.

2. **Provider-resilient generation**
   - Use `/v1/chat/generate` with `provider=auto`.

3. **Secrets management**
   - Encrypt credentials via `/v1/vault/encrypt`, decrypt when needed.

4. **Session analytics**
   - Read `/v1/sessions` and `/v1/sessions/:id/events`.

5. **Ops observability**
   - Monitor `/v1/ops/status` + `/metrics` in dashboards.

---

## 4) FAQ

## Q: Do I need API tokens in local development?
A: If `MEMPHIS_API_TOKEN` is unset, auth checks are relaxed. For production: always set token.

## Q: Why vault endpoints return 503?
A: Usually missing `RUST_CHAIN_ENABLED=true`, missing/short `MEMPHIS_VAULT_PEPPER`, or bridge not built.

## Q: What is the default data location?
A: `~/.memphis` (or `MEMPHIS_DATA_DIR` if set).

## Q: How do I back up everything quickly?
A: `memphis backup create` then `memphis backup verify <file>`.

## Q: How do I switch providers?
A: Set `provider` in `/v1/chat/generate` request (`auto`, `ollama`, etc.).
