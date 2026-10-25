# Generic dotenv writes could bypass vault protection — 2026-10-19

## TL;DR

The legacy `upsertEnvVars` and `removeEnvVars` helpers did not apply the initialized
vault's pepper guard. Both writer families also accepted assignment injection via
keys or newline-containing values. Generic writers now share validation, both
configuration journals, recovery, the pepper guard and private atomic publication.
The public return shapes and intentional rotation operations are preserved.

## Root cause and evidence

An existing 18-case security fixture passed seven cases and failed eleven against
the starting worktree. The legacy writers could replace, clear or remove the
pepper and ignored the vault-state journal. Both writer families accepted injected
assignments. The existing direct dotenv guard already blocked explicit pepper
changes, but only pepper requests took the vault-state lock.

Two additional cases per writer reproduced further failures: a pair of quotes in
different values could consume the existing pepper line without a newline in
either input; an unrelated write could modify dotenv before recovery of a pending
vault transaction, invalidating its expected file identity. The expanded fixture
passed seven cases and failed fifteen before the fix. All fixture data is synthetic;
these results do not establish that an operator credential was exposed or changed.

## Resolution

`mutateDotEnvFile` validates every requested key and rejects newline-containing
values before recovery or publication. Both old and new set/unset helpers use it.
Every generic edit now acquires the vault-state and dotenv journals in the existing
stable order and completes pending recovery before reading configuration. The
initialized-state check runs while holding those locks, including after recovery.

Explicit pepper mutations are refused. The proposed output is also parsed to
detect indirect pepper changes caused by editing other lines. A refusal publishes
none of the requested batch. Recovery can still finish an already prepared
transaction; refusing a new mutation does not cancel earlier durable intent.
Ordinary field writes and first-run pepper setup remain supported.

## Verification

Codex implemented and self-reviewed this slice; no independent review is claimed.
The expanded 22-case writer fixture and eight existing writer compatibility cases
passed. A separate local encrypted-v2 acceptance fixture checks both writer
families, MCP, HTTP and an elevated TUI host, with unchanged file bytes, process
pepper and configuration generation after refusals. A fresh process loads dotenv
and reads the credential through both TS/NAPI and native Rust.

The final frozen local selection passed 114 tests in 16 files, with zero failures
or skips. It includes both rotations at all six SIGKILL points, recovery from the
historical journal, configuration reload, writer compatibility and error handling.
Source, protected-file and initial Git-index comparisons passed after testing.
Earlier smaller runs overlap this selection and are not additional unique tests.

The CLI handler currently exposes `config tools` and `config surfaces`; generic
`config set` returns usage. That negative case is recorded separately and is not
claimed as a working generic CLI mutation command. The TUI acceptance invokes the
host capability, not the native command parser. HTTP's existing secret-field gate
rejects the request before persistence. The local acceptance fixture depends on
earlier uncommitted runtime-snapshot/launch-fixture work and is kept outside this
standalone source commit.

Private baseline, rollback artifacts and execution reports:
`/home/memphis/.memphis-backup-s1-config-writers-954zflqw` (mode 0700).

## Limits and follow-ups

This fixes generic set/unset writers. Setup/template-copy paths and explicit backup
restore still require their own acceptance; they must not be described as covered
by the generic-writer fixture. Review those paths next, including `setup --force`
with an existing vault and a missing dotenv during repair. Complete V01 and the
remaining S1 gates before claiming the full refactor accepted. No power-loss,
native finalizer stress or complete release acceptance is implied.
