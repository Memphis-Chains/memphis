# Cognitive & Decision Review - Task #37 Report

## 1. ModelD private key non-persistent

**File:** `src/cognitive/model-d.ts:96`

**Problem:** Private key generated randomly on every instantiation - vote signatures invalidated after restart.

**Proposed fix:**
```typescript
constructor(config: ModelDConfig, store: IStore = new ChainStore(), privateKey?: string) {
  this.privateKey = privateKey ?? crypto.randomBytes(32).toString('hex');
}
```

**Test:** Verify same key produces same signature across instantiations.

---

## 2. Insight type icon map not typed

**File:** `src/cognitive/model-e.ts:525-526`

```typescript
const icon = { pattern: '🎯', trend: '📈', anomaly: '⚠️', opportunity: '🌟', risk: '🚨' };
```

**Proposed fix:**
```typescript
const INSIGHT_ICONS: Record<Insight['type'], string> = {
  pattern: '🎯', trend: '📈', anomaly: '⚠️', opportunity: '🌟', risk: '🚨'
};
```

---

## 3. DecisionType literal duplicated

**File:** `src/cognitive/types.ts:24,38`

`'strategic' | 'tactical' | 'technical'` appears in two interfaces.

**Proposed fix:** Extract to shared `DecisionType`.

---

## Summary

| # | File | Issue | Priority |
|---|------|-------|----------|
| 1 | model-d.ts:96 | Ephemeral private key | High |
| 2 | types.ts:24,38 | DecisionType duplicated | Low |
| 3 | model-e.ts:525 | Icon map not typed | Low |
