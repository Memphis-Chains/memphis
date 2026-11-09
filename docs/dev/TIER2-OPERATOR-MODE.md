# Operator authentication for Tier 2

By default, the existing separate Tier 2 verifier remains required. An operator
who deliberately wants to use the operator password for Tier 2 can select that
mode locally:

```text
memphis trust tier2 operator
```

The command requires a fresh local terminal and operator password. If an
independent Tier 2 verifier was already configured, it also requires that
password before changing the mode. No password is written to the manifest;
the configured operator verifier is used for future Tier 2 authentication.
The command does not change the self-governance SLO gate or approve a change.

`memphis trust tier2 separate` returns to the independent verifier only when
one already exists. An installation with no independent verifier remains
fail-closed unless its operator explicitly selects operator mode. The CLI
does not currently provide a command for creating a separate verifier.

Evolution preparation and review continue to require the exact reviewed
request or commit; dream acceptance retains its signed operator approval.
Code and operator run under the same OS account, so this is an application
guard rather than isolation from an unrestricted local process.
