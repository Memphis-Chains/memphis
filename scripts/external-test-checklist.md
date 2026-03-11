# External Tester Checklist

## Pre-Test

- [ ] I have a fresh host/VM ready
- [ ] I have internet access
- [ ] I have 30 minutes available
- [ ] I'm NOT the project author

## During Test

### Installation (Target: < 5 min)

Start time: **\_**

- [ ] git clone
- [ ] npm install
- [ ] npm run build
- [ ] npm run onboard
      End time: **\_**
      Total: **\_** minutes

### Doctor Check

```text
[paste output]
```

### Basic Smoke

- [ ] `memphis ask --input "2+2"` returns answer
- [ ] Response time acceptable

### Vault Test

- [ ] Vault init succeeds
- [ ] DID generated: **\*\*\*\***\_\_\_**\*\*\*\***
- [ ] Store/retrieve works

### Decision Test

- [ ] Decision created
- [ ] Hash: **\*\*\*\***\_\_\_**\*\*\*\***
- [ ] Chain verification PASS

## Post-Test

### Ratings (1-5)

- Installation difficulty: \_\_\_
- Documentation clarity: \_\_\_
- First-run experience: \_\_\_
- Would recommend: Y/N

### Issues Found

[List any problems, confusing steps, errors]

### Screenshots Attached

- [ ] Doctor output
- [ ] Vault DID
- [ ] Decision hash
- [ ] Any errors

## Submit

Send completed checklist + screenshots to project maintainer.
