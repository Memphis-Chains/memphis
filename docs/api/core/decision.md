# Core API: decision

## Signatures
- `inferDecisionFromText(input: string): DecisionSignal`
- `appendDecisionAudit(event: DecisionAuditEvent, path?: string): DecisionAuditAppendResult`
- `decisionAuditPath(path: string): string`
- `readDecisionAudit(path?: string): DecisionAuditEvent & object[]`
- `appendDecisionHistory(decision: DecisionRecord, options?: object): string`
- `decisionHistoryPath(path: string): string`
- `readDecisionHistory(path?: string): DecisionHistoryEntry[]`
- `createDecision(params: object): DecisionRecord`
- `transitionDecision(record: DecisionRecord, to: DecisionStatus, nowIso: string): DecisionRecord`

## Examples

```ts
// import from runtime modules and call with validated input
```
