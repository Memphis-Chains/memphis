# Modules & Orchestration Review - Task #35 Report

## 1. request.input! non-null assertion crash risk

**File:** `src/modules/orchestration/task-executor.ts:203`

```typescript
const inputDigest = createHash('sha256').update(request.input!).digest('hex');
```

**Fix:**

```typescript
if (!request.input) {
  throw new AppError('VALIDATION_ERROR', 'input field is required for generate digest', 400);
}
const inputDigest = createHash('sha256').update(request.input).digest('hex');
```

---

## 2. Fallback provider bypasses cooldown check

**File:** `src/modules/orchestration/service.ts:231`

**Fix:** Add cooldown check before fallback:

```typescript
if (this.providerPolicy.isInCooldown(fallbackName)) {
  throw new AppError('PROVIDER_UNAVAILABLE', `Fallback provider in cooldown: ${fallbackName}`, 503);
}
```

---

## Summary

| #   | File                 | Issue                    | Priority |
| --- | -------------------- | ------------------------ | -------- |
| 1   | task-executor.ts:203 | input! crash risk        | High     |
| 2   | service.ts:231       | fallback cooldown bypass | High     |
