# SKILLS.md — the contract a skill owes the runtime

> The rule: **a sidecar's audit storage MUST NOT live under `chains/`.**
> Cross-linked from
> [the 2026-09-22 postmortem](../postmortems/2026-09-22-chains-halt-invalid-block-shape.md)
> (items A1 and C1).

## Why this is a rule and not a preference

On 2026-09-22 a skill wrote its audit trail into the chain corpus —
`chains/halt/*.json` — and Memphis crashed at the next boot. The chain
corpus is not a directory where anything may live: every directory under
`chains/` is read as a chain, every file in it is read as a block, and a
block that does not fit the shape ends the process. The audit trail of a
skill is a sidecar — it belongs next to the corpus, not inside it.

The corpus moved the audit out on 2026-09-16
(`~/.memphis/chains/halt/` → `~/.memphis/audit/halt/`), but the RULE had
no owner: it was a paragraph in a postmortem, and nothing read it. A rule
that lives in a document is a rule that a new skill never meets.

## The contract

Every skill under `skills/` carries a `## Sidecar contract` section that
states two things:

```markdown
## Sidecar contract

- **Sidecar writes:** `~/.memphis/audit/halt/events.jsonl`
- **Audit target:** `~/.memphis/audit/halt/events.jsonl`
```

- **Sidecar writes** — every path the skill writes persistently. Write
  `none` if it writes none. That is an answer, not an omission.
- **Audit target** — the audit trail the skill writes, if any. `none` is
  an answer here too.

The section is read by the gate, so the declaration is not a promise to a
reader — it is what the gate checks.

## The gate

```bash
npm run -s ops:check-skill-contracts
```

It fails when a skill:

- has no `## Sidecar contract` section;
- does not declare its sidecar writes, or its audit target;
- declares an empty value (`none` is the way to say "nothing");
- declares a path **under `chains/`** — the shape that crashed the
  runtime.

The rule itself lives in `src/infra/audit/skill-sidecar-contract.ts`, and
the corpus that pins it lives in
`tests/fixtures/skill-contract-cases.json`. The gate and the corpus are
two runners of one rule; the postmortem asked for a `compat.test.sh` per
skill, and that would have been seven copies of one rule.

## What the skills in this repository declare

| Skill                        | Sidecar writes                                           | Audit target                             |
| ---------------------------- | -------------------------------------------------------- | ---------------------------------------- |
| `halt-aware-destructive-ops` | `~/.memphis/audit/halt/events.jsonl`, `~/.memphis/halt/` | `~/.memphis/audit/halt/events.jsonl`     |
| `memphis-hotfix`             | none (the repository's source)                           | none (the commit)                        |
| `memphis-rebuild-rust`       | none (the crate's build output)                          | none (the build output)                  |
| `memphis-v5-landing-rebuild` | none (the repository's sites)                            | none (the deploy report)                 |
| `play-customer-promo-video`  | `/tmp/<player>-skill-<pid>.log`                          | none (temporary)                         |
| `remote-site-edit`           | none (the remote webroot and its backup)                 | none (the pre-deploy report)             |
| `usb-grabber-feed`           | `~/.memphis/logs/grabber-feed-daily.log`                 | `~/.memphis/logs/grabber-feed-daily.log` |

## The runtime's own sidecars

The runtime keeps its sidecars outside the corpus for the same reason:

- the halt registry — `~/.memphis/halt/`;
- the halt audit trail — `~/.memphis/audit/halt/events.jsonl`;
- the security audit log — `~/.memphis/logs/`;
- the boot-failure counter — `~/.memphis/state/boot-failures.json`.

`chains/` holds chains, and nothing else.
