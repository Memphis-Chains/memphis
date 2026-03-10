# Multi-Node Transport Evidence Framework

## Purpose
Validate Memphis v4 multi-node synchronization and transport integrity.

## Architecture

```
Node A (Primary)          Node B (Secondary)
┌─────────────┐          ┌─────────────┐
│   Memphis   │◄────────►│   Memphis   │
│  (Port A)   │  Sync    │  (Port B)   │
└─────────────┘          └─────────────┘
     │                         │
     └───────── Ledger ────────┘
```

## Test Scenarios

### Scenario 1: Basic Sync

**Setup:**
1. Start Node A (primary)
   ```bash
   MEMPHIS_NODE_ID=node-a MEMPHIS_PORT=3001 memphis serve
   ```

2. Start Node B (secondary)
   ```bash
   MEMPHIS_NODE_ID=node-b MEMPHIS_PORT=3002 memphis serve --sync-with http://localhost:3001
   ```

**Steps:**
1. Create decision on Node A
   ```bash
   memphis --port 3001 decide "Test" "Choice A" "Reason"
   ```

2. Verify sync to Node B
   ```bash
   memphis --port 3002 decisions list
   ```

3. Check ledger consistency
   ```bash
   memphis --port 3001 ledger status
   memphis --port 3002 ledger status
   ```

**Success Criteria:**
- [ ] Decision appears on both nodes
- [ ] Ledger checksums match
- [ ] Sync latency < 1 second

**Evidence to Capture:**
- Decision hash from both nodes
- Ledger status outputs
- Sync timing logs

---

### Scenario 2: Conflict Resolution

**Setup:** Same as Scenario 1

**Steps:**
1. Create conflicting decisions simultaneously
   ```bash
   # Terminal 1 (Node A)
   memphis --port 3001 decide "Conflict test" "Choice A" "From A"

   # Terminal 2 (Node B) - immediately after
   memphis --port 3002 decide "Conflict test" "Choice B" "From B"
   ```

2. Check resolution
   ```bash
   memphis --port 3001 decisions list
   memphis --port 3002 decisions list
   ```

**Success Criteria:**
- [ ] Both nodes have consistent state
- [ ] Conflict resolved deterministically
- [ ] No data loss

**Evidence to Capture:**
- Final decision state on both nodes
- Conflict resolution log
- Timing diagram

---

### Scenario 3: Transport Integrity

**Setup:** Same as Scenario 1

**Steps:**
1. Enable transport signatures
   ```bash
   export MEMPHIS_TRANSPORT_SIGN=true
   ```

2. Sync large chain
   ```bash
   # Generate test chain on Node A
   for i in {1..100}; do
     memphis --port 3001 decide "Test $i" "Choice $i" "Reason $i"
   done

   # Trigger full sync on Node B
   memphis --port 3002 sync --full
   ```

3. Verify signatures
   ```bash
   memphis --port 3002 verify --transport
   ```

**Success Criteria:**
- [ ] All 100 decisions synced
- [ ] Transport signatures valid
- [ ] No tampering detected

**Evidence to Capture:**
- Verification output
- Block count on both nodes
- Signature validation log

---

## Evidence Template

**Test Date:** [YYYY-MM-DD]  
**Node A:** [Host:Port]  
**Node B:** [Host:Port]

### Scenario Results

| Scenario | Status | Sync Latency | Integrity Check |
|----------|--------|--------------|-----------------|
| Basic Sync | ⬜ | __ms | ✅/❌ |
| Conflict Resolution | ⬜ | __ms | ✅/❌ |
| Transport Integrity | ⬜ | __ms | ✅/❌ |

### Ledger Checksums

| Node | Block Count | Chain Hash | Ledger Hash |
|------|-------------|------------|-------------|
| A | ___ | [hash] | [hash] |
| B | ___ | [hash] | [hash] |

### Transport Logs
[Attach relevant log excerpts]

---

## Publication Checklist

- [ ] All scenarios PASS
- [ ] Ledger consistency verified
- [ ] Transport signatures validated
- [ ] Evidence documented
- [ ] Ready for external audit
