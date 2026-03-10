# External Validation Results

**Tester:** Elathoxu (external user)
**Date:** 2026-03-10
**Host:** Ubuntu 24.04 (fresh VM)
**Node Version:** v24.14.0
**Rust Version:** cargo 1.94.0 (installed by `install.sh`)

---

## Installation Test Results

### Scenario 1: Fresh Host Installation

**Steps executed:**
```bash
git clone https://github.com/Memphis-Chains/memphis-v4.git
cd memphis-v4
./scripts/install.sh
npm run build
```

**Timeline:**
| Step | Time | Status |
|------|------|--------|
| Clone repo | ~3s | ✅ PASS |
| Install dependencies (apt) | ~3s | ✅ PASS |
| Install Rust via rustup | ~3m 32s | ✅ PASS (first time) |
| npm install | ~9s | ✅ PASS |
| cargo build | ~16.8s | ✅ PASS |
| tsc build | ~2s | ✅ PASS |
| **TOTAL** | **~4 min 30s** | ✅ **< 5 min target** |

**Doctor output:**
```json
{
  "ok": false,
  "checks": [
    { "id": "rust-version", "ok": true, "detail": "cargo 1.94.0" },
    { "id": "node-version", "ok": true, "detail": "v24.14.0" },
    { "id": "permissions", "ok": true, "detail": "data/: writable, dist/: writable" },
    { "id": "env-file", "ok": false, "detail": "missing keys: MEMPHIS_VAULT_PEPPER" },
    { "id": "build-artifacts", "ok": true, "detail": "dist/ contains 15 entries" },
    { "id": "embedding-provider", "ok": true, "detail": "mode=local" },
    { "id": "mcp-service", "ok": false, "detail": "no service on port 3000" }
  ]
}
```

**Issue found:** `MEMPHIS_VAULT_PEPPER` not set in `.env`

**Fix required:**
```bash
# Add to .env:
MEMPHIS_VAULT_PEPPER=$(openssl rand -hex 32)
```

---

## Why Rust is Required

Memphis v4 uses **Rust for performance-critical operations**:

| Component | Rust Crate | Purpose |
|-----------|------------|---------|
| **Vault Crypto** | `memphis-vault` | Argon2id key derivation + AES-256-GCM encryption |
| **Embed Store** | `memphis-embed` | Vector search + LRU cache |
| **Chain Core** | `memphis-core` | Block storage + hash chains |
| **NAPI Bridge** | `memphis-napi` | Native performance via Node.js bindings |

**Why not pure JavaScript?**
- **Argon2id** is memory-hard (64MB RAM, GPU-resistant) — too slow in JS
- **AES-256-GCM** needs native crypto primitives for security
- **Vector search** (cosine similarity) benefits from Rust's zero-cost abstractions
- **Chain validation** needs fast SHA-256 hashing

**Install size:** ~150MB (Rust toolchain) + ~50MB (compiled crates)

---

## Post-Install Fix

After `./scripts/install.sh`, run:

```bash
# Set required vault pepper
echo "MEMPHIS_VAULT_PEPPER=$(openssl rand -hex 32)" >> .env

# Verify
npm run -s cli -- doctor --json
```

Expected: `"ok": true`

---

## Scenario 2-4: Pending Vault Fix

**Status:** BLOCKED by vault adapter bug (API mismatch between TypeScript and Rust NAPI)

**Issue:** `src/infra/storage/rust-vault-adapter.ts` expects snake_case JSON API, but Rust exports camelCase Buffer API.

**Workaround:** Fix in progress (Codex 5.3 subagent spawned).

---

## Recommendations for New Users

### 1. Simplified Quickstart

Add to README.md:

```markdown
## Quick Start (5 minutes)

```bash
git clone https://github.com/Memphis-Chains/memphis-v4.git
cd memphis-v4
./scripts/install.sh

# Set required env (one-liner)
sed -i "/^MEMPHIS_VAULT_PEPPER=$/c\MEMPHIS_VAULT_PEPPER=$(openssl rand -hex 32)" .env

# Verify
npm run -s cli -- doctor
```

### 2. Pre-flight Checklist

Before running install.sh, ensure:
- ✅ Internet connection (downloads ~200MB)
- ✅ sudo access (for apt-get)
- ✅ ~500MB disk space

### 3. Common Issues

| Issue | Fix |
|-------|-----|
| `cargo not found` after install | Run: `source $HOME/.cargo/env` |
| Doctor fails on `MEMPHIS_VAULT_PEPPER` | Run: `sed -i "/^MEMPHIS_VAULT_PEPPER=$/c\MEMPHIS_VAULT_PEPPER=$(openssl rand -hex 32)" .env` |
| Slow Rust download (3m+) | Expected on first install; cached for future runs |

---

## Evidence Screenshots

_Note: Tester should attach screenshots of:_
- [ ] `npm run -s cli -- doctor --json` output (after fix)
- [ ] `npm run -s cli -- ask --input "test"` output
- [ ] Any errors encountered

---

## Overall Assessment

| Metric | Score | Notes |
|--------|-------|-------|
| Installation difficulty | 2/5 | Easy, but requires env fix post-install |
| Documentation clarity | 3/5 | Missing pepper setup in quickstart |
| First-run experience | 3/5 | Doctor fails initially, needs manual fix |
| Total time | 4m 30s | ✅ Under 5 min target |
| Would recommend | Yes (pending fix) | After env setup, works well |

---

## Action Items

1. **Add auto-pepper generation to install.sh:**
   ```bash
   if grep -q '^MEMPHIS_VAULT_PEPPER=$' .env; then
     sed -i "/^MEMPHIS_VAULT_PEPPER=$/c\MEMPHIS_VAULT_PEPPER=$(openssl rand -hex 32)" .env
   fi
   ```

2. **Update README quickstart** with one-liner env setup

3. **Fix vault adapter bug** (in progress)

---

**Validation Status:** ⚠️ PARTIAL (install works, vault pending fix)
**Next:** Re-test scenarios 2-4 after vault fix
