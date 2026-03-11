# Memphis v5 Quickstart (5 minutes)

Single canonical quickstart guide.

## Prerequisites

- Node.js 20+
- Rust + Cargo
- Git

## 1) Install and verify

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis-v5
./scripts/install.sh
memphis health
npm run -s cli -- doctor --json
```

If doctor returns `"ok": true`, Memphis is ready.

## 2) First memory workflow (CLI)

```bash
npm run -s cli -- embed reset
npm run -s cli -- embed store --id first-note --value "Today I installed Memphis v5 and want local-first memory"
npm run -s cli -- embed search --query "local memory" --top-k 5 --tuned
```

## 3) First API workflow (optional)

### Health

```bash
curl -s http://127.0.0.1:3000/health
```

### Generate

```bash
curl -s http://127.0.0.1:3000/v1/chat/generate \
  -H "Authorization: Bearer $MEMPHIS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":"Hello Memphis","provider":"auto"}'
```

### Journal + recall

```bash
curl -s http://127.0.0.1:3000/api/journal \
  -H "Authorization: Bearer $MEMPHIS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"First Memphis journal entry","tags":["onboarding"]}'

curl -s http://127.0.0.1:3000/api/recall \
  -H "Authorization: Bearer $MEMPHIS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"onboarding","limit":5}'
```

## 4) Next docs

- [API Reference](./API-REFERENCE.md)
- [Operations Manual](./OPERATIONS-MANUAL.md)
- [Debug Commands](./DEBUG-COMMANDS.md)
- [CLI Command Matrix](./CLI-COMMAND-MATRIX.md)
