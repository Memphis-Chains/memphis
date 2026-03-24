# Security Scan Report - Auth & Security Modules

## CRITICAL ISSUES

**1. Fail-Closed Policy Infrastructure is UNUSED**
- `src/security/fail-closed.ts` defines `failClosed()`, `allow()`, `deny()`, `evaluateFailClosed()`, `combineResults()`
- These are **never imported** anywhere else in the codebase
- All auth checks bypass the fail-closed evaluation system entirely

**2. Bug in `constantTimeBufferCompare` (`src/security/constant-time.ts:47`)**
```typescript
void (byteA ^ byteB);  // Result is discarded!
```
Should be: `result |= byteA ^ byteB`

---

## HIGH PRIORITY

**3. Weak Password Hashing** (`operator-gate.ts:108-110`)
- Uses `SHA-256(salt + passphrase)` - vulnerable to GPU brute force
- Should use PBKDF2/bcrypt/Argon2

**4. No Test Coverage for Security Modules**
- No test files in `src/security/` or `src/infra/auth/`
- Security regressions cannot be detected

**5. Passphrase Visible During Input** (`operator-gate.ts:154-155`)
- readline doesn't hide input - acknowledged in code

---

## MEDIUM PRIORITY

**6. Session Authorization Not Persistent** - module-level variable, lost on restart
**7. No Rate Limiting on Passphrase Attempts** - vulnerable to online brute force
**8. Recovery Hash Uses Same Salt** - should use separate derivation

---

## Proposed Sprint Tasks

| Priority | Task |
|----------|------|
| P0 | Integrate `fail-closed.ts` into auth pipeline |
| P0 | Fix `constantTimeBufferCompare` bug |
| P1 | Add password hashing (PBKDF2/Argon2) to operator-gate |
| P1 | Add security module tests |
| P2 | Add rate limiting for passphrase attempts |
| P2 | Add TTY raw mode for passphrase masking |
| P3 | Separate salt derivation for recovery hash |
