# Knip export audit — 2026-07-11

`npm run deadcode:check` passes. `npm run deadcode:report` reports 179 unused
exports and exits non-zero by design; it is an audit inventory, not a deletion
gate.

## Classification policy

- **Public/compatibility:** exported runtime, provider, storage, configuration,
  schema, and CLI helpers remain available to downstream consumers even when
  this package has no internal import.
- **Test/operations:** reset helpers, constants, schedulers, recovery helpers,
  and status formatters are retained for tests, scripts, and operator tooling.
- **Dynamic ownership:** MCP tools, CLI commands, provider adapters, native
  bridge helpers, and managed-app/skill functions may be reached through
  registries, dynamic imports, package exports, or runtime discovery.
- **Internal candidates:** exports not covered above require a repository-wide
  reference and package-compatibility review before removal.

The complete candidate inventory is reproducible with
`npm run deadcode:report`. No candidates were bulk-deleted. During this pass,
the newly extracted tier-session handler was proven registrar-private and its
unnecessary export was removed. New Telegram and executor helper exports are
covered directly by unit tests and intentionally form their domain-module
interfaces.

## Follow-up rule

Remove an export only in a focused change that includes reference search,
package-surface review, and relevant tests. Keep `deadcode:check` limited to
files and dependencies until the compatibility-owned inventory is ratcheted
down deliberately.
