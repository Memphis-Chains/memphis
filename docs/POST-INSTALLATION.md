# Memphis Post-Installation Guide

After install/build, the active Memphis `v1.x` operator path is:

```bash
npm run bootstrap
memphis init
memphis health --json
memphis tui
```

Related docs: [GETTING-STARTED.md](./GETTING-STARTED.md) · [TESTING-VERIFICATION.md](./TESTING-VERIFICATION.md) · [QUICK-START-SCENARIOS.md](./QUICK-START-SCENARIOS.md)

## 1) Controlled first-run

`memphis init` is the only canonical operator-first onboarding flow. It handles:

- operator passphrase enrollment,
- vault initialization,
- first-state mode selection,
- preview and confirmation of initial chain writes,
- final health summary.

Do not use `memphis configure` or the old onboarding wizard as the primary path.

## 2) Verify runtime health

```bash
memphis doctor --fix
memphis health --json
memphis guide
```

Expected result:

- doctor reports a healthy or repairable runtime,
- health reports `runtimeStatus: "healthy"` after a clean first-run,
- guide shows the same `bootstrap -> init -> health -> tui` story.

## 3) Check memory and agent path

```bash
memphis embed store --id note-1 --value "Memphis post-install test"
memphis search --query "Memphis post-install test" --top-k 5 --chain journal
memphis ask --input "What do you know about Memphis post-install test?"
```

## 4) Optional follow-up

- Edit `.env` only when you need provider or runtime overrides after `init`
- use `memphis setup matrix --json` only for the optional Matrix trusted-pilot path
- use `memphis repair runtime` if health reports degraded derived state

## 5) Next steps

Deprecated downstream OpenClaw paths are archived and not part of the active
Memphis `v1.x` operator flow.

1. Run full validation: [TESTING-VERIFICATION.md](./TESTING-VERIFICATION.md)
2. Choose a deployment profile: [QUICK-START-SCENARIOS.md](./QUICK-START-SCENARIOS.md)
