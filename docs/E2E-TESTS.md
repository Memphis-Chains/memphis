# E2E Workflow Tests

File: `tests/e2e/full-workflow.e2e.test.ts`

## Covered workflows

1. **Journal workflow**
   - write: `POST /v1/chat/generate` with session id
   - recall: `GET /v1/sessions/:id/events`
   - verify: stored event metadata (`requestId`, `providerUsed`)

2. **Ask workflow**
   - ask question with `ask --session`
   - follow-up question in same session
   - verify context continuity (`output` includes prior context + `contextTurns > 0`)

3. **Decision workflow**
   - propose decision record (created in test)
   - accept via `decide transition --to accepted`
   - verify via `decide history --id ...`

4. **Embed workflow**
   - store vectors via mocked local bridge
   - search via local bridge API
   - verify ranking order (best hit first)

## Local-fallback / no external dependencies

- Ask + Journal use `DEFAULT_PROVIDER=local-fallback`
- Embed uses an in-test mock bridge (`bridge.cjs`) in a temp directory
- No network providers required

## Isolation and cleanup

- Every test creates its own temp directory
- Runtime files (sessions, DB, history, mocked bridge) are confined to temp paths
- Temp data is removed in `finally` cleanup blocks

## Run

```bash
npm run test:e2e
```
