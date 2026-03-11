# Memphis v5 — SECURITY SCAN REPORT

Date: 2026-03-11  
Scope: `src/**/*.ts` (138 files, static audit)  
Phase: Pre-v1.0.0 comprehensive security review

---

## Executive Summary

Security posture before v1.0.0 is **not production-safe** yet.

**Critical themes found:**
1. **Remote command execution exposure risk** in Gateway when auth token is unset.
2. **Path traversal + weak chain integrity** in TS legacy chain writer.
3. **Stored XSS** risk in dashboard template rendering.
4. **Auth model depends on optional env token**, creating insecure-by-misconfiguration behavior.
5. **Crypto/auth verification weaknesses** in trade and collective-vote flows.
6. **DoS protections are incomplete** in custom HTTP servers (Gateway/MCP transport).

---

## Findings (by severity)

## CRITICAL

### 1) Gateway auth can be silently disabled (RCE surface)
- **Where:** `src/gateway/server.ts:63-71`, `src/gateway/server.ts:181-189`
- **Issue:** `/exec` runs shell commands. Auth is enforced **only if** `config.authToken` is set.
- **Impact:** If gateway is started without token (misconfig), attacker can execute allowed commands remotely. If exec policy is loosened (`restrictedMode=false`), this becomes full RCE.
- **Evidence:**
  - Exec route: `return exec(command, { cwd, timeout });`
  - Auth guard conditional: `if (route.auth && this.config.authToken) { ... }`
- **Fix:**
  - Fail startup if `/exec` exists and auth token missing.
  - Enforce auth unconditionally for sensitive routes.
  - Add mTLS or signed request scheme for gateway control plane.

### 2) Path traversal in chain writes + arbitrary write outside intended chain dir
- **Where:** `src/infra/http/server.ts:256-267`, `src/infra/storage/chain-adapter.ts:104-106`
- **Issue:** `/api/journal` accepts user-controlled `chain`; TS fallback uses `path.join(home, '.memphis', 'chains', chainName)` with no sanitization.
- **Impact:** `chainName` like `../../...` can escape intended path and write files/directories in unintended locations.
- **Fix:**
  - Strict whitelist for chain name (`^[a-z0-9_-]{1,64}$`).
  - Resolve path and enforce prefix (`resolved.startsWith(baseDir)` after `path.resolve`).
  - Reject path separators and traversal tokens.

### 3) Chain integrity is effectively broken in TS legacy adapter
- **Where:** `src/infra/storage/chain-adapter.ts:121-123`
- **Issue:** Hash is only `sha256(JSON.stringify(data))`; `prev_hash` is hardcoded empty (`TODO`).
- **Impact:** No immutable chain linkage; block tampering, reordering, truncation may go undetected.
- **Fix:**
  - Include index/timestamp/prev_hash/canonicalized payload in hash.
  - Load previous block hash and enforce continuity.
  - Add append-time and read-time integrity verification.

---

## HIGH

### 4) Stored XSS in dashboard HTML rendering
- **Where:** `src/dashboard/web-dashboard.ts:385-420` and dynamic template sections below
- **Issue:** Unescaped values (`title`, `reasoning`, `description`, tags, actions, mood) are interpolated directly into HTML.
- **Impact:** If block content is attacker-controlled (journal/import/sync), arbitrary JS can execute in dashboard clients.
- **Fix:**
  - Escape HTML entities before interpolation.
  - Prefer server-side templating with auto-escaping.
  - Add CSP headers (`default-src 'self'; script-src 'self'`).

### 5) Optional API token causes auth bypass-by-configuration for HTTP API
- **Where:** `src/infra/http/server.ts:74-77`, `src/infra/config/schema.ts:11-13`
- **Issue:** Protected routes require auth policy, but if `MEMPHIS_API_TOKEN` missing, requests pass.
- **Impact:** On exposed dev/default deployments (`HOST=0.0.0.0`), sensitive APIs may be unauthenticated.
- **Fix:**
  - Require token whenever server binds non-loopback, regardless of NODE_ENV.
  - Secure defaults: host `127.0.0.1`, deny startup without token in non-local mode.

### 6) Signature verification weakness in trade protocol
- **Where:** `src/sync/trade.ts:19-26`
- **Issue:** Uses fallback static secret (`memphis-v5-vault-fallback`) and `expected === signature` (non constant-time).
- **Impact:** Signature forgery risk in weakly configured env; timing side-channel (low practical but avoidable).
- **Fix:**
  - Fail hard when secret missing.
  - Use `crypto.timingSafeEqual` for verification.
  - Move to asymmetric signing (Ed25519) for peer trust.

### 7) Vote verification is non-cryptographic
- **Where:** `src/cognitive/model-d.ts:353-357`
- **Issue:** `verifyVote` only checks signature length (`===64`).
- **Impact:** Any forged vote accepted if length matches.
- **Fix:**
  - Implement actual signature verification against signer public key.
  - Bind signature to vote payload + nonce + timestamp.

### 8) Gateway CORS wildcard on control endpoints
- **Where:** `src/gateway/server.ts:166-168`
- **Issue:** `Access-Control-Allow-Origin: *` on all routes including control-plane endpoints.
- **Impact:** Cross-origin abuse in browser contexts (especially if bearer token leaks/stored client-side).
- **Fix:**
  - Restrict CORS origins.
  - Disable CORS for non-browser control plane unless explicitly needed.

---

## MEDIUM

### 9) Request body size not bounded in custom HTTP servers (DoS risk)
- **Where:** `src/gateway/server.ts` (`readBody`), `src/mcp/transport/http.ts:18-23`
- **Issue:** Raw body accumulation without explicit byte limit.
- **Impact:** Memory exhaustion from oversized payloads.
- **Fix:**
  - Enforce max body size while streaming; terminate early with 413.
  - Apply timeout and max headers/URL constraints.

### 10) Security utilities exist but are not integrated
- **Where:** `src/security/request-limits.ts`, `src/security/unicode-normalizer.ts`, `src/security/constant-time.ts`
- **Issue:** Security helpers are mostly unused in HTTP/Gateway/MCP routes.
- **Impact:** Inconsistent protections (unicode normalization, length limits, constant-time compares).
- **Fix:**
  - Centralize security middleware and enforce for every ingress path.

### 11) MCP HTTP transport lacks auth (local-only assumption)
- **Where:** `src/mcp/transport/http.ts:74`
- **Issue:** No authentication/authorization, relies on loopback bind only.
- **Impact:** If bound/proxied externally, full MCP tool surface exposed.
- **Fix:**
  - Add optional token or mTLS even for localhost mode.
  - Explicit warning/fail when non-loopback bind is introduced.

---

## LOW

### 12) Rate limiter is in-memory and process-local
- **Where:** `src/infra/http/rate-limit.ts`
- **Issue:** Not distributed/persistent; resets on restart and can be bypassed via horizontal scaling.
- **Fix:** Redis/shared rate limiter for production.

### 13) Health monitor uses `execSync` shell pattern (currently static payload)
- **Where:** `src/mcp/health-monitor.ts:66`
- **Issue:** Current use is static and not exploitable now, but introduces shell dependency anti-pattern.
- **Fix:** Replace with direct object serialization.

---

## Coverage by requested areas

1. **Input validation**
   - Strong in some Zod routes (`/v1/chat/generate`, vault endpoints).
   - Weak/absent in `/api/journal`, `/api/decide`, gateway `/exec`, custom body readers.
   - Path traversal and XSS vectors confirmed.

2. **Cryptographic security**
   - SHA-256 used widely.
   - Critical weaknesses: default fallback key, non-constant compare in trade, fake vote verification.
   - `security/constant-time.ts` exists but not consistently used.

3. **Chain security**
   - TS legacy chain path is not cryptographically chained (`prev_hash` TODO).
   - Integrity manager exists but not enforced in append/read pipeline.

4. **Authentication/authorization**
   - Auth policy is defined, but runtime allows bypass when token unset.
   - Gateway auth optional; high-risk for control routes.

5. **Network security**
   - Rate limiting present but basic.
   - CORS wildcard in gateway.
   - Body-size DoS controls incomplete in custom servers.

---

## Refactoring Priorities (ordered)

### P0 — Blocker before v1.0.0
1. **Make auth mandatory** for gateway `/exec` and HTTP protected routes when not loopback.
2. **Sanitize chain names + path confinement** in all chain write paths.
3. **Fix chain cryptographic linkage** in TS fallback (`prev_hash` + canonical hash fields).
4. **Escape dashboard output** + add CSP.

### P1 — Next hardening wave
5. Replace trade verification with constant-time compare + no fallback key.
6. Implement real vote signature verification in model-d.
7. Add body/header/request-size guards to gateway and MCP HTTP transports.
8. Restrict/disable wildcard CORS on gateway.

### P2 — Reliability/security maturity
9. Integrate `security/*` utilities as centralized ingress middleware.
10. Upgrade rate limiting to shared backend (Redis).
11. Add security regression tests (path traversal, XSS payloads, oversized body, auth bypass).

---

## Suggested Security Test Cases (must add to CI)

- **Auth:** requests to protected endpoints without token must fail in all non-local modes.
- **Traversal:** `/api/journal` with `chain="../../tmp/pwn"` must be rejected.
- **XSS:** stored payload `<img src=x onerror=alert(1)>` must render escaped in dashboard.
- **DoS:** oversized body (> configured limit) must return 413 quickly.
- **Crypto:** trade signature compare uses timing-safe path; missing key must fail startup.
- **Chain:** tampered block must fail integrity verification.

---

## Final Assessment

Current state: **High Risk** for internet-exposed or misconfigured deployments.  
Recommended release gate: **Do not ship v1.0.0 until all P0 items are closed and tested.**
