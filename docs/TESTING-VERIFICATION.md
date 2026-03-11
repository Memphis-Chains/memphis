# Memphis v5 Testing & Verification ✅

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
memphis ask "What is 2+2?"
```
Expected: coherent LLM response.

### Embeddings path
```bash
memphis memory index --text "Memphis verification sample"
memphis memory search "verification"
```
Expected: indexed item appears in search results.

### Vault path
```bash
memphis vault status
memphis vault list | head
```
Expected: vault initialized and readable.

---

## 3) Performance benchmarks

```bash
time memphis ask "Summarize Memphis architecture in 3 bullets"
time memphis memory search "architecture"
```

Target guidance (local recommended host):
- Ask response: < 8s typical
- Memory search: < 2s typical

⚠️ Values vary by model size and hardware.

---

## 4) Integration tests

### Ollama API integration
```bash
curl -s http://127.0.0.1:11434/api/tags | jq '.models | length'
```
Expected: integer > 0 if at least one model pulled.

### OpenClaw plugin integration (optional)
```bash
openclaw --version
openclaw plugin list | grep -i memphis || true
```
Expected: plugin listed when installed.

---

## 5) End-to-end workflow test

```bash
memphis memory index --text "E2E: Memphis stores this memory"
memphis ask "Find my E2E memory"
memphis memory search "E2E"
```

Expected workflow:
1. Index command succeeds
2. Ask command references stored context (depending on provider config)
3. Search returns inserted memory

---

## 6) Expected output checklist

| Test | Pass Signal | Fail Signal |
|---|---|---|
| CLI health | `status: ok` | non-zero exit, missing deps |
| Embeddings | vector/search results returned | provider/model errors |
| Vault | initialized + list/export works | vault missing/corrupt |
| Ollama | `/api/tags` responds | connection refused/timeout |
| OpenClaw plugin | plugin visible + callable | plugin not found |

If failures occur, use [TROUBLESHOOTING-DECISION-TREE.md](./TROUBLESHOOTING-DECISION-TREE.md).
