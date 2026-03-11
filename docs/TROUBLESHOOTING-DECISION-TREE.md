# Memphis v5 Troubleshooting Decision Tree 🛠️

Use this quick decision flow to isolate and fix installation/runtime problems.

Related docs: [PREREQUISITES.md](./PREREQUISITES.md) · [OLLAMA-SETUP.md](./OLLAMA-SETUP.md) · [TESTING-VERIFICATION.md](./TESTING-VERIFICATION.md)

---

## 1) Installation fails

Check:
```bash
node --version
npm --version
rustc --version
cargo --version
python3 --version
```

Then:
```bash
npm ci
npm run build
```

If still failing:
- ✅ verify system packages installed
- ✅ clear npm cache: `npm cache verify`
- ✅ retry with clean checkout

---

## 2) Build fails

Check A/B/C:

```bash
npm run build
npm run lint
npm run test
```

Common fixes:
- Remove stale artifacts: `rm -rf dist node_modules && npm install`
- Ensure Rust toolchain is healthy: `rustup show`
- Check TypeScript config drift

---

## 3) Runtime errors

Check D/E/F:

```bash
memphis --version
memphis health
memphis --help
```

Also inspect environment:
```bash
grep -E '^MEMPHIS_|^OPENAI_|^ANTHROPIC_' .env || true
```

Fixes:
- Missing provider keys
- Wrong `MEMPHIS_OLLAMA_BASE_URL`
- Broken local config file permissions

---

## 4) Ollama issues

Check G/H/I:

```bash
ollama --version
systemctl status ollama --no-pager || true
curl -s http://127.0.0.1:11434/api/tags
```

Fixes:
- Start service: `sudo systemctl enable --now ollama`
- Pull required model: `ollama pull nomic-embed-text`
- Resolve 11434 port conflicts

---

## 5) Performance issues

Check J/K/L:

```bash
free -h
nproc
top -b -n1 | head -n 20
```

Fixes:
- Use smaller models
- Reduce concurrency (`OLLAMA_NUM_PARALLEL`)
- Add RAM/swap (with caution)
- Keep vault/index on SSD/NVMe

---

## 6) Common errors and fixes

| Error | Likely Cause | Fix |
|---|---|---|
| `memphis: command not found` | Not linked/installed globally | `npm link` or use `npm run cli -- ...` |
| `ECONNREFUSED 127.0.0.1:11434` | Ollama not running | start service + verify URL |
| `model not found` | Missing Ollama model | `ollama pull nomic-embed-text` |
| `rustc not found` | Rust not installed in shell profile | source `~/.cargo/env` |
| `EACCES` npm install issues | permissions mismatch | avoid sudo npm global in user env |

---

## 7) Text-based decision flowchart

```text
Start
 ├─ Is memphis command available?
 │   ├─ No → npm link / npm run cli -- --help
 │   └─ Yes
 ├─ Does memphis health pass?
 │   ├─ No → check .env + provider config
 │   └─ Yes
 ├─ Using Ollama?
 │   ├─ Yes → is 127.0.0.1:11434 reachable?
 │   │   ├─ No → restart ollama service, check logs
 │   │   └─ Yes → model exists?
 │   │       ├─ No → ollama pull nomic-embed-text
 │   │       └─ Yes → run embedding smoke test
 │   └─ No → verify cloud API keys/providers
 └─ Run scripts/test-installation.sh → PASS => done ✅
```
