# Fresh-install verification

After every major release (v1.10.0, v1.11.0, …) the operator runs
through this checklist on a clean machine — or a temp `MEMPHIS_HOME`
on an existing machine — to prove the install path still works
end-to-end. Pairs with [`CLEAN-INSTALL.md`](./CLEAN-INSTALL.md) (the
install instructions) — this doc is **verification**, not install.

Closes P2 #9 from `docs/roadmap/2026-05-11-post-autonomy-todo-and-gap.md`.

## TL;DR — automated smoke

```bash
bash scripts/fresh-install-test.sh
```

Output ends with `[ok] All 5 smoke steps passed`. Spins up a temp
install under `/tmp/memphis-fresh-<timestamp>/`, runs the 5-step
canonical first-run, prints PASS/FAIL with stage info, then deletes
the temp install on exit. Add `--keep` to retain it for post-mortem
inspection, `--verbose` to stream output instead of suppressing.

Exit codes: 0=pass, 1=init failed, 2=health failed, 3=doctor critical,
4=vault round-trip failed, 5=chain write failed, 9=missing prerequisite
(`memphis` CLI not on PATH).

**Run on the existing daemon's machine?** Yes — the smoke uses a temp
`MEMPHIS_HOME`, so the operator's real daemon is untouched.

## Manual walkthrough (full, ~10 minutes)

If you want to verify the human-facing flow as well — i.e. what a
brand-new operator actually sees — walk through these steps on a
clean install (Linux/macOS/WSL2). Each step has a verification line
the operator can run + an expected outcome.

### 1. Run the one-liner installer

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash
```

Verify:

```bash
which memphis        # expect: /usr/local/bin/memphis (or wherever PATH points)
memphis --version    # expect: 1.10.0 (or whatever the current tag is)
```

### 2. First run — `memphis init`

```bash
memphis init
```

The operator is prompted (in order) for:

1. **Operator passphrase** — gates state-mutating CLI commands.
2. **Vault passphrase** — encrypts API keys + tokens at rest.
3. **Recovery question + answer** — used by `memphis operator recover`
   when the operator passphrase is forgotten.
4. **Agent display name** (defaults to "Memphis Agent").
5. **Owner display name** (defaults to "local operator").

Verify:

```bash
memphis health --json | jq -r '.ok'   # expect: true
memphis doctor --json | jq -r '.gates.tier' | grep -i critical
# expect: no output (no critical findings)
```

### 3. Add at least one provider

For cloud:

```bash
memphis provider add anthropic --api-key <your-key>
# or:
memphis provider add minimax --api-key <your-key>
```

For local-only:

```bash
ollama pull cogito:3b           # Memphis defaults to cogito:3b when MINIMAX/Anthropic absent
```

Verify:

```bash
memphis providers list
# expect: at least one provider with `configured=true`
```

### 4. Install + start the daemon

```bash
memphis service install         # systemd-user unit on Linux/WSL
memphis service restart
memphis service status
# expect: active (running)
```

### 5. First conversation — agent characterization

Open the TUI:

```bash
memphis tui
```

Use the **Chat** surface to walk through the operator-agent
characterization flow described in
[`GUIDE-AGENT-NURTURING.md`](./GUIDE-AGENT-NURTURING.md):

- "Cześć, jestem <imię>" — Memphis writes the operator profile.
- "Komunikuj się ze mną po polsku, krótko i konkretnie" — Memphis
  writes the style preference.
- "Nadaj sobie charakter" — Memphis proposes a character and stores
  it after operator confirmation.
- "Jakie są twoje narzędzia?" — Memphis calls `memphis_self_describe`
  and reports.

Verify:

```bash
# After a few turns of the characterization flow, the journal chain
# should have at least one block per turn:
memphis search --query "operator profile" --top-k 3
# expect: hits surfacing the captured style + character preferences
```

### 6. Telegram (optional but typical)

```bash
memphis setup telegram --bot-token <bot-token> --allowed-user-ids <your-tg-id>
memphis service restart
```

Verify on Telegram:

- Send `/start` — Memphis greets.
- Send a text question — get a reply.
- Send a voice note — get a voice reply (TTS — requires
  `bash scripts/voice-install.sh` first).
- Send a PDF — Memphis reads the content and answers questions
  about it. (Requires the v1.10.0+ document handler.)
- Send a photo — Memphis describes it via vision + OCR.

### 7. Vault smoke

```bash
echo "test-value" | memphis vault add fresh_install_smoke --stdin
memphis vault get fresh_install_smoke
# expect: test-value
memphis vault list | grep fresh_install_smoke
# expect: the key listed
```

### 8. Self-update awareness

```bash
memphis self-update check
# expect: either "you're on latest" OR "v1.X.Y available" depending
# on when the operator runs this
```

## Cleanup (manual walkthrough only)

The temp-MEMPHIS_HOME smoke (`scripts/fresh-install-test.sh`) cleans
itself up on exit. For the manual walkthrough, the install is yours
to keep — but if you want to reset:

```bash
memphis service stop
memphis reset --runtime --yes        # nukes ~/.memphis/, keeps the binary
# or full uninstall:
memphis service uninstall
```

## When to run

- **Before tagging any release** — catches regressions in the install
  path before they reach a new operator.
- **After any change to `scripts/install.sh`, `scripts/install-prerequisites.sh`,
  `scripts/voice-install.sh`, the `memphis init` flow, or the vault
  cryptography path.**
- **After bumping any native dependency** (`better-sqlite3`,
  `onnxruntime-node`, the Rust NAPI bridge).
- **Periodically on the operator's main machine** — once a month is
  enough to catch silent platform drift (apt upgrades, Node minor
  bumps, etc.).

## Reporting a failure

When a step fails:

1. Re-run with `--keep --verbose` to preserve the temp install + log:
   ```bash
   bash scripts/fresh-install-test.sh --keep --verbose
   ```
2. Capture the temp dir path + last 50 lines of the log file printed.
3. Open an issue against `Memphis-Chains/memphis` with:
   - Output of `memphis --version`
   - OS + kernel: `uname -a`
   - Failing step number + the exit code
   - Log tail (`tail -50 /tmp/memphis-fresh-<ts>.log`)
   - What `memphis doctor --json` reports against the temp home

## Related

- [`CLEAN-INSTALL.md`](./CLEAN-INSTALL.md) — canonical install instructions
- [`INSTALL.md`](./INSTALL.md) — manual install variant
- [`POST-INSTALLATION.md`](./POST-INSTALLATION.md) — post-install runbook
- [`GUIDE-AGENT-NURTURING.md`](./GUIDE-AGENT-NURTURING.md) — characterization flow
- [`UPGRADE.md`](./UPGRADE.md) — upgrade between versions
