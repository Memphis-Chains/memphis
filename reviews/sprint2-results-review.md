# Sprint 2 Results - All Fixes Applied

## Completed P0 Fixes

| Task | Fix | Agent | Status |
|------|-----|-------|--------|
| #20 SyncStorage | SyncManager → per-block files (compatible with chain-adapter) | sync-fix-agent | ✅ |
| #21 FailClosed | Integrated fail-closed.ts into auth pipeline | failclosed-agent | ✅ |
| #22 ConstantTime | Fixed `void (byteA ^ byteB)` → `result |= byteA ^ byteB` | consttime-agent | ✅ |
| #23 HealthMonitor | Real bridge check + chain verify (removed stubs) | healthmon-agent | ✅ |
| #24 MCP Buffer | 5s timeout + 1MB max buffer (DoS prevention) | mcpbuf-agent | ✅ |
| #25 ModelBConfig | Unified types.ts + model-b.ts interfaces | modelb-agent | ✅ |
| #26 DecisionPersist | Added `store.append()` in DecisionLifecycle.create() | decision-persist-agent | ✅ |
| #27 GLM Integration | GlmLlmProvider → OrchestrationService | glm-agent | ✅ |

---

## Key Changes Summary

### #20 - SyncManager Storage Fix
- SyncManager now uses per-block numbered files like chain-adapter
- Supports legacy flat JSON for backward compatibility
- Async readChain/writeChain with proper locking

### #21 - Fail-Closed Integration
- fail-closed evaluation wrapped around auth decisions in server.ts
- Missing API token → deny via evaluateFailClosed()
- Invalid bearer → deny via evaluateFailClosed()
- Valid auth → allow()

### #22 - ConstantTime Bug Fix
- Fixed result accumulation bug in constantTimeBufferCompare
- 33/33 security tests passing

### #23 - HealthMonitor Real Checks
- checkBridgeConnectivity now uses getChainAdapterStatus() + NapiChainAdapter()
- checkChainIntegrity now uses verifyChainIntegrity() instead of echo mock

### #24 - MCP Buffer Limits
- MAX_BUFFER_SIZE = 1MB
- BUFFER_TIMEOUT_MS = 5s
- Timer reset on each data event
- Cleanup on close/error events

### #25 - ModelBConfig Unified
- types.ts and model-b.ts now share same interface
- DEFAULT_CONFIG includes all required fields

### #26 - DecisionLifecycle Persistence
- Added store: IStore to constructor
- store.append() called after validation
- Decisions now persist across restarts

### #27 - GLM Integration
- GlmLlmProvider wrapper implements LLMProvider interface
- 'glm' added to ProviderName type
- container.ts registers when GLM_API_KEY is set
