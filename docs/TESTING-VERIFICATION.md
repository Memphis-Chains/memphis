# Memphis Testing & Verification ✅

Use this playbook to validate installation quality from smoke checks to E2E.

Related docs: [POST-INSTALLATION.md](./POST-INSTALLATION.md) · [TROUBLESHOOTING-DECISION-TREE.md](./TROUBLESHOOTING-DECISION-TREE.md)

---

## 1) Smoke tests (quick checks)

```bash
bash scripts/verify-installation.sh
bash scripts/test-installation.sh
```

Expected:

```text
PASS: node
PASS: npm
PASS: rust
PASS: memphis
...
Summary: all critical checks passed
```

---

## 2) Feature verification

### Cognitive model path

```bash
memphis ask --input "What is 2+2?"
```

Expected: coherent LLM response.

### Embeddings path

```bash
memphis embed store --id verification-sample --value "Memphis verification sample"
memphis embed search --query "verification"
```

Expected: indexed item appears in search results.

### RC candidate proof

```bash
npm run ops:rc-drill:fresh-env
```

Expected:

- isolated temp runtime root is created
- bootstrap + vault init/add/get pass
- semantic recall and exact search both return valid JSON
- Rust TUI check-only sanity passes
- HTTP and MCP sanity pass
- package artifact proof passes
- Matrix stays optional and bounded unless explicitly enabled

### Vault path

```bash
memphis vault list
memphis vault list | head
```

Expected: vault initialized and readable.

---

## 3) Performance benchmarks

```bash
npm run -s bench:retrieval:gate
npm run -s bench:cli-tui
npm run -s bench:cli-tui:gate
```

Target guidance (deterministic local benchmark):

- Retrieval tuned recall@k: >= 0.85
- Retrieval tuned MRR: >= 0.80
- Retrieval delta recall@k: >= +0.18

Operator latency SLOs (set from baseline on 2026-03-12):

- CLI startup p95: <= 500ms
- CLI startup p99: <= 700ms
- TUI refresh p95: <= 10ms
- TUI refresh p99: <= 15ms

See:

- `docs/RETRIEVAL-BENCHMARK.md`
- `docs/CLI-TUI-LATENCY-BENCHMARK.md`

Rust core safety quick gate:

```bash
npm run -s ops:rust-core:safety
```

Main branch protection verification:

```bash
GITHUB_TOKEN=<token> npm run -s ops:verify-main-protection
```

---

## 4) Integration tests

### Ollama API integration

```bash
curl -s http://127.0.0.1:11434/api/tags | jq '.models | length'
```

Expected: integer > 0 if at least one model pulled.

### Matrix trusted-pilot verification (optional bounded path)

```bash
memphis setup matrix --json
memphis guide --json | jq '.sections[] | select(.title=="Tools")'
```

Expected:

- setup output stays truthful and does not emit a fake access token
- trusted-pilot wording remains visible in operator truth
- public-federation hardening remains explicitly deferred

---

## 5) End-to-end workflow test

```bash
memphis embed store --id e2e-sample --value "E2E: Memphis stores this memory"
memphis ask --input "Find my E2E memory"
memphis embed search --query "E2E"
```

Expected workflow:

1. Index command succeeds
2. Ask command references stored context (depending on provider config)
3. Search returns inserted memory

---

## 6) Expected output checklist

| Test            | Pass Signal                     | Fail Signal                 |
| --------------- | ------------------------------- | --------------------------- |
| CLI health      | `status: ok`                    | non-zero exit, missing deps |
| Embeddings      | vector/search results returned  | provider/model errors       |
| Vault           | initialized + list/export works | vault missing/corrupt       |
| Ollama          | `/api/tags` responds            | connection refused/timeout  |
| Matrix trusted pilot | truthful setup + bounded wording | fake readiness or token contract |

If failures occur, use [TROUBLESHOOTING-DECISION-TREE.md](./TROUBLESHOOTING-DECISION-TREE.md).
