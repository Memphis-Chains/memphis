# External Tester Checklist

## Pre-Test

- [ ] I have a fresh host/VM ready
- [ ] I have internet access
- [ ] I have 30 minutes available
- [ ] I'm NOT the project author

## During Test

### Installation (Target: < 5 min)

Start time: _____
- [ ] git clone
- [ ] npm install
- [ ] npm run build
- [ ] npm run onboard
End time: _____
Total: _____ minutes

### Doctor Check

```text
[paste output]
```

### Basic Smoke

- [ ] `memphis ask "2+2"` returns answer
- [ ] Response time acceptable

### Vault Test

- [ ] Vault init succeeds
- [ ] DID generated: ___________________
- [ ] Store/retrieve works

### Decision Test

- [ ] Decision created
- [ ] Hash: ___________________
- [ ] Chain verification PASS

## Post-Test

### Ratings (1-5)

- Installation difficulty: ___
- Documentation clarity: ___
- First-run experience: ___
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
