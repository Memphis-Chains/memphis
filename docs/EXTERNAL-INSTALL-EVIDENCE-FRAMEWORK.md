# External Install Evidence Framework

## Purpose
Validate that non-authors can install and use Memphis v4 in < 5 minutes.

## Test Scenarios

### Scenario 1: Fresh Host Installation (Critical Path)

**Prerequisites:**
- Fresh Ubuntu 22.04/24.04 host (or clean VM)
- No prior Memphis installation
- Internet access

**Steps:**
1. Clone repository
   ```bash
   git clone https://github.com/Memphis-Chains/memphis-v4.git
   cd memphis-v4
   ```

2. Run onboarding
   ```bash
   npm install
   npm run build
   npm run onboard
   ```

3. Verify installation
   ```bash
   memphis doctor
   ```

4. Basic smoke test
   ```bash
   memphis ask "What is 2+2?" --json
   ```

**Success Criteria:**
- [ ] Installation completes in < 5 minutes
- [ ] `memphis doctor` shows all PASS
- [ ] Basic ask command returns response
- [ ] No manual intervention needed

**Evidence to Capture:**
- Screenshot of `memphis doctor` output
- Timing log (start → finish)
- Any errors encountered
- System info (OS, Node version, Rust version)

---

### Scenario 2: Provider Configuration

**Steps:**
1. Configure provider
   ```bash
   memphis provider add openai-compatible --api-key $OPENAI_API_KEY
   ```

2. Test provider
   ```bash
   memphis provider test openai-compatible
   ```

3. Multi-turn session
   ```bash
   memphis ask-session --provider openai-compatible --model gpt-4
   > What is Rust?
   > /stats
   > /exit
   ```

**Success Criteria:**
- [ ] Provider configuration succeeds
- [ ] Test returns healthy status
- [ ] Multi-turn session works with /stats command

**Evidence to Capture:**
- Provider test output
- Session screenshot with /stats
- Latency metrics

---

### Scenario 3: Vault Operations

**Steps:**
1. Initialize vault
   ```bash
   memphis vault init
   # Enter passphrase
   # Answer 2FA question
   ```

2. Store secret
   ```bash
   memphis vault store "test_key" "secret_value"
   ```

3. Retrieve secret
   ```bash
   memphis vault retrieve "test_key"
   ```

**Success Criteria:**
- [ ] Vault initialization completes
- [ ] DID generated (did:memphis:...)
- [ ] Store/retrieve roundtrip works

**Evidence to Capture:**
- DID output
- Store/retrieve success messages

---

### Scenario 4: Decision Recording

**Steps:**
1. Create decision
   ```bash
   memphis decide "Which framework?" "React" "Large ecosystem"
   ```

2. Query decisions
   ```bash
   memphis decisions list
   ```

3. Verify chain integrity
   ```bash
   memphis verify
   ```

**Success Criteria:**
- [ ] Decision recorded with hash
- [ ] Decision appears in list
- [ ] Chain verification PASS

**Evidence to Capture:**
- Decision hash
- Verification output

---

## Evidence Template

**Tester:** [Name/ID]  
**Date:** [YYYY-MM-DD]  
**Host OS:** [Ubuntu 22.04/24.04, etc.]  
**Node Version:** [vXX.XX.XX]  
**Rust Version:** [X.XX.X]

### Scenario Results

| Scenario | Status | Time | Notes |
|----------|--------|------|-------|
| Fresh Install | ⬜ | __m __s | |
| Provider Config | ⬜ | __m __s | |
| Vault Ops | ⬜ | __m __s | |
| Decision Recording | ⬜ | __m __s | |

### Screenshots
- [ ] Doctor output
- [ ] Provider test
- [ ] Ask session /stats
- [ ] Vault DID
- [ ] Decision hash

### Issues Encountered
[List any errors, confusing messages, or improvements needed]

### Overall Assessment
- Installation difficulty: [1-5]
- Documentation clarity: [1-5]
- First-run experience: [1-5]
- Would recommend: [Yes/No]

---

## Publication Checklist

After external validation:
- [ ] All scenarios PASS
- [ ] Evidence documented in `docs/EXTERNAL-VALIDATION-RESULTS.md`
- [ ] Screenshots attached to evidence doc
- [ ] Total install time < 5 minutes
- [ ] No critical issues found
