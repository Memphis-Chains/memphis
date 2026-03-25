# MemphisOS Production Audit Findings
**Date:** 2026-03-25

## GH Issues Created (4)
- **#17**: [SECURITY] secret command bypasses operator authentication
- **#18**: [SECURITY] Legacy vault functions use zero-salt encryption and hardcoded pepper
- **#19**: [SECURITY] configure command uses hardcoded default passphrase in non-interactive mode
- **#20**: [UX] Dual config systems: setup vs configure create different config files

---

## Critical Commands Audit (serve, doctor, vault, apps, workspace)

### CRITICAL
| ID | Issue | File:Line |
|----|-------|-----------|
| C1 | Doctor JSON output breaks on network errors (AbortSignal.timeout swallows error) | doctor-v2.ts:100-104 |
| C2 | Vault re-init without backup - `--force` causes silent data loss | vault.handler.ts:33-42 |
| C3 | Bootstrap graceful degradation - soul/embed failures are silent, server starts degraded | bootstrap.ts:244-252 |

### HIGH
| ID | Issue | File:Line |
|----|-------|-----------|
| H1 | No input validation on vault key/value - empty strings pass | vault.handler.ts:57-62 |
| H2 | Workspace context file overwrite without atomic write - TOCTOU race | context.ts:195-198 |
| H3 | Vault state path uses predictable default `./data/vault-state.json` | rust-vault-adapter.ts:118-120 |
| H4 | Doctor checks leak internal filesystem paths | doctor-v2.ts:1000-1005 |
| H5 | Pepper strength check only validates 3 char classes, not entropy | doctor-v2.ts:567-569 |

### MEDIUM
| ID | Issue | File:Line |
|----|-------|-----------|
| M1 | `--verbose` exposes full stack traces in production | errors.ts:225-238 |
| M2 | Apps handler silent failure on invalid actions | apps.handler.ts:229-243 |
| M3 | Bootstrap has no timeout on async operations (queue recovery can hang) | bootstrap.ts:276 |
| M4 | Doctor `--fix` writes to production Memphis directory | doctor-v2.ts:905-909 |
| M5 | Context sync TOCTOU race between existsSync and readFileSync | context.ts:182-191 |
| M6 | Vault entry store has no concurrent access control (no file locking) | vault-entry-store.ts:43-47 |

---

## Security Audit

### CRITICAL
| ID | Issue | File:Line |
|----|-------|-----------|
| S1 | **`vault add/get/list` NOT gated** - only `secret` commands are gated, but vault provides equivalent functionality | operator-gate.ts:36-45 |
| S2 | Gateway `/exec` loopback bypass - `GATEWAY_DANGEROUSLY_ALLOW_EXEC=true` bypasses auth for 127.0.0.1, IPv6-mapped IPv4, X-Forwarded-For spoofing risk | gateway/server.ts:208-226, 337-342 |

### HIGH
| ID | Issue | File:Line |
|----|-------|-----------|
| S3 | Vault v1→v2 transparent upgrade writes plaintext masterKey to disk briefly | rust-vault-adapter.ts:246-255 |
| S4 | Command injection risk - `execCommand()` in onboarding wizard accepts arbitrary strings | onboarding/wizard.ts:67-74 |
| S5 | Vault entry key names not validated - special chars could cause issues | vault-entry-store.ts:74 |

### MEDIUM
| ID | Issue | File:Line |
|----|-------|-----------|
| S6 | MCP vault tools (`vault-get.ts`, `vault-list.ts`) lack operator gate | mcp/tools/vault-get.ts:25-37 |
| S7 | Recovery answer only requires non-empty, no min length/complexity | operator-gate.ts:260-264 |
| S8 | CLI parser doesn't validate injection characters in flag values | cli/utils/parser.ts:79-99 |

### LOW
| ID | Issue | File:Line |
|----|-------|-----------|
| S9 | Fallback to v1 vault if pepper < 12 chars - plaintext masterKey on disk | rust-vault-adapter.ts:200-208 |
| S10 | Rate limit window reset allows brute force (4 attempts, wait 15min, repeat) | operator-gate.ts:126-133 |

---

## Bootstrap/Init Flows Audit

### CRITICAL
| ID | Issue | File:Line |
|----|-------|-----------|
| B1 | Two inconsistent onboarding systems (`setup` vs `onboarding wizard`) - different behavior, different validation | setup.ts vs onboarding-wizard.ts |
| B2 | Agent profile path mismatch - `.env` in CWD, agent profile in `~/.memphis/config/` | agent-profile.ts:28-30 |

### HIGH
| ID | Issue | File:Line |
|----|-------|-----------|
| B3 | `setup` doesn't create subdirectories (chains, embeddings, vault, config) | setup.ts:557 |
| B4 | `onboarding wizard` doesn't create data directory - fails if `MEMPHIS_DATA_DIR` doesn't exist | onboarding-wizard.ts:317 |
| B5 | Vault enrollment not idempotent - re-running attempts re-enrollment | setup.ts:586-593 |
| B6 | First-run marker written before validation completes | index.ts:14-22 |

### MEDIUM
| ID | Issue | File:Line |
|----|-------|-----------|
| B7 | Provider connectivity check only in `setup`, not in `onboarding wizard` | setup.ts:400-447 |
| B8 | Rust bridge status check only in `setup` | setup.ts:571-578 |
| B9 | `onboarding bootstrap` bypasses first-run checks from `index.ts` | storage.handler.ts:186-196 |
| B10 | Workspace init separate from setup/onboarding | workspace.ts:32-70 |
| B11 | `MEMPHIS_API_TOKEN` is optional in schema but required in production | schema.ts:43, profiles.ts:37 |
| B12 | `setup --force` overwrites existing agent profile | agent-profile.ts:88-103 |
| B13 | No validation of `MEMPHIS_DATA_DIR` during setup | setup.ts:132-148 |

---

## Idempotency Summary
| Command | Safe to Re-run? |
|---------|----------------|
| `setup --force` | Partial - overwrites `.env`, merges agent profile |
| `onboarding wizard --write --force` | Partial - same, no directory creation |
| `onboarding bootstrap --apply --yes` | **No** - regenerates tokens each run |
| `doctor --fix` | Yes |
| `workspace init --force` | Yes |
| `soul seed` | Yes |

---

## Positive Security Findings
- SQL injection: All SQLite uses parameterized statements
- Exec policy: Gateway exec uses restrictive allowlist with regex
- Token comparison: Uses `secureCompare` for timing attack prevention
- File permissions: Vault state file set to `0o600` after writing
- Secret generation: Uses `crypto.randomBytes()`
