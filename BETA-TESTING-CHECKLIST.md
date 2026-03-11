# Memphis v0.2.0-beta.1 — Beta Testing Checklist

Use this checklist before and during public beta validation.

## 1) Installation & Upgrade

### Fresh install
- [ ] Clone repository
- [ ] Run `npm install`
- [ ] Run `npm run build`
- [ ] Run `npm run -s cli -- doctor --json` and confirm `"ok": true`
- [ ] Run `npm run -s cli -- health --json`

### Package install (beta tag)
- [ ] Configure GitHub Packages auth (`~/.npmrc`)
- [ ] Install beta package: `npm install @memphis-chains/memphis-v5@beta`
- [ ] Confirm version: `memphis --version` → `0.2.0-beta.1`

### Upgrade path from alpha
- [ ] Existing alpha installation can upgrade cleanly
- [ ] No data loss in chain/vault/retrieval state
- [ ] CLI commands remain operational after upgrade

---

## 2) Core test scenarios

### A. Memory + retrieval basics
- [ ] Create journal entries
- [ ] Search and recall expected entries
- [ ] Validate retrieval relevance and ordering

### B. Caching behavior
- [ ] Repeat same retrieval query 5x
- [ ] Observe reduced latency after warm cache
- [ ] Verify cache does not return stale/broken data

### C. Multi-agent sync (MVP)
- [ ] Export chain from Agent A
- [ ] Import/pull into Agent B
- [ ] Push updates back and verify consistency
- [ ] Test conflict/duplicate handling and document outcomes

### D. Security and resilience
- [ ] Vault workflows: init/unlock/read/write
- [ ] Run smoke scripts related to security/runtime hardening
- [ ] Confirm graceful behavior on malformed inputs

### E. API + MCP
- [ ] Start API and run health/status checks
- [ ] Validate at least one MCP flow (stdio or HTTP)
- [ ] Confirm errors map to expected responses

---

## 3) Regression checks (from alpha)

- [ ] Ask→persist→recall still works
- [ ] Session APIs still work (`/v1/sessions` etc.)
- [ ] Metrics/status/ops endpoints still available
- [ ] Install script still works on Linux/macOS/WSL

---

## 4) Feedback collection process

## Report template
- **Environment:** OS, Node, Rust, install method
- **Version:** output of `memphis --version`
- **Scenario tested:** (from checklist section)
- **Expected behavior:**
- **Actual behavior:**
- **Logs/artifacts:** command output, screenshots, stack traces
- **Severity:** blocker / high / medium / low

## Channels
- [ ] GitHub Issues (`bug`, `beta-feedback` labels)
- [ ] Internal release thread / testing channel
- [ ] Daily beta triage summary (group by severity)

## Exit criteria for beta→next tag
- [ ] No open blocker issues
- [ ] High severity issues triaged with fix plan
- [ ] Installation success confirmed on target platforms
- [ ] Multi-agent sync smoke scenarios stable
