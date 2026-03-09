# PHASE5 GATE EVIDENCE

Date: 2026-03-09
Scope: phase5 decision gate MVP + v2 lifecycle transition

## Commands

```bash
npm run -s test:ts -- tests/unit/decision-gate.test.ts
npm run -s test:smoke:phase5-decision
npm run -s test:ts -- tests/unit/decision-lifecycle.test.ts
npm run -s test:smoke:phase5-transition
npm run -s cli -- decide --input "Decyduję: provider - ollama" --json
npm run -s cli -- decide transition --input '<DecisionRecord JSON>' --to accepted --json
```

## Expected markers
- `[smoke-phase5-decision] PASS`
- `[smoke-phase5-transition] PASS`
- `decide` output: `"ok": true`, `"signal.detected": true`
- `decide transition` output: `"ok": true`, `"mode": "decide-transition"`, `"decision.status": "accepted"`

## Gate verdict (current)
- Status: PASS (phase5 gate MVP + lifecycle transition v2)
- Remaining for full phase5 closure:
  - persistence/audit trail for transitions
  - richer infer-to-lifecycle E2E linkage
