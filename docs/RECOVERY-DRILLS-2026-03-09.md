# Recovery Drills — 2026-03-09

## Bridge recovery drill output
[STEP] Ensure services are running
[STEP] Simulate failure (stop bridge)
[STEP] Trigger healthcheck service 3x (to reach auto-restart threshold)
[STEP] Verify recovery
[PASS] bridge recovered
[STEP] Runtime smoke
DRILL_OLLAMA_BRIDGE_RECOVERY_OK

## Vault recovery drill output
[STEP] Start app with missing rust bridge (degraded mode expected)
[PASS] server up
[STEP] Verify vault path fails safely before recovery
[PASS] vault fails safely without bridge
[STEP] Run recovery path via deterministic vault runtime E2E
[STEP] Preparing mock rust vault bridge
[PASS] mock rust vault bridge
[STEP] Starting memphis-v4 HTTP server on 127.0.0.1:3887
[STEP] Waiting for /health
[PASS] server is up
[STEP] Vault init
[PASS] vault init
[STEP] Vault encrypt
[PASS] vault encrypt
[STEP] Vault decrypt
[PASS] vault decrypt
[STEP] Vault entries integrity
[PASS] vault entries integrity
E2E_VAULT_RUNTIME_OK
[PASS] vault runtime recovered and E2E passed
DRILL_VAULT_RUNTIME_RECOVERY_OK
