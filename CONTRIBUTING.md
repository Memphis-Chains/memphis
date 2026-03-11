# Contributing to Memphis v5

Thanks for improving Memphis.
This guide defines the expected workflow for production-grade contributions.

## Development setup

### Prerequisites

- Node.js 20+
- npm 10+
- Rust + Cargo
- Git

### Bootstrap

```bash
git clone https://github.com/Memphis-Chains/memphis-v5.git
cd memphis-v5
./scripts/install.sh
```

### Validate local environment

```bash
npm run -s cli -- doctor --json
npm run lint
npm run typecheck
npm test
npm run build
cargo test --workspace
```

## Pull request guidelines

- Keep PRs focused and small enough to review safely.
- Link related issue(s) when applicable.
- Describe:
  - **scope** (what changed)
  - **risk** (what could break)
  - **rollback** (how to revert safely)
- Update docs and changelog for user-visible behavior changes.
- Never commit secrets, tokens, or credentials.
- Preserve backward compatibility unless explicitly approved for major release changes.

## Code style

- TypeScript: ESLint + Prettier enforced.
- Rust: idiomatic style; keep tests close to logic.
- Prefer explicit contracts and typed boundaries.
- Keep modules cohesive; avoid cross-cutting side effects.
- Name scripts and commands clearly for operators.

Run before pushing:

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
cargo test --workspace
```

## Testing requirements

Minimum green gate before PR review:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `cargo test --workspace`

For changes touching runtime, security, or release flow, also run relevant smoke packs (for example `npm run release:smoke` or targeted `test:smoke:*` scripts).

## Required workflow: 3 commits + 1 PR

Use this delivery discipline for non-trivial work:

### Commit 1 — Foundation
- Add core implementation skeleton and contracts.
- Include basic tests or placeholders.

### Commit 2 — Hardening
- Complete logic, validations, and error handling.
- Add/expand tests to cover edge cases.

### Commit 3 — Evidence & docs
- Update docs, changelog, and operational notes.
- Ensure reproducible verification commands are documented.

### PR (single)
- Open one PR containing the 3 commits.
- Wait for green CI and required approvals.
- Merge using project merge policy.

## Commit message style (recommended)

Conventional Commits are preferred:

- `feat: ...`
- `fix: ...`
- `docs: ...`
- `refactor: ...`
- `test: ...`
- `chore: ...`

---

If you are unsure whether a change is safe for production, open a draft PR early and request maintainer guidance.
