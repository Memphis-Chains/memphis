# Memphis one-truth Phase 3 - tool surface parity - 2026-06-04

Scope: make the public tool surface auditable across the canonical registry,
the in-process tool executor, and the MCP server.

## Implemented

- Added `src/gateway/tool-surface-audit.ts`.
- The audit extracts `memphis_*` tool names from:
  - `src/gateway/tool-registry.ts` registry entry keys
  - `src/gateway/tool-executor.ts` `buildTool({ name })` handler bindings
  - `src/mcp/server.ts` `server.registerTool(name)` registrations
- Added doctor Tier A check:
  - id: `ta15-tool-surface-parity`
  - pass when all three surfaces expose the same tool names
  - fail when a tool exists in one surface but not the others
- Added unit coverage in `tests/unit/tool-surface-audit.test.ts`.
- Extended the doctor JSON test to require the new check id.

## Current Truth

- Registry source tools: 55
- In-process executor source tools: 55
- MCP server source tools: 55
- Missing from registry: none
- Missing from executor/MCP: none

This is an audit gate, not the final deduplication. The current code still
keeps manual declarations in more than one place, but doctor now detects drift
immediately.

Runtime-visible tool counts may be lower because feature flags are applied
after registration. With `MEMPHIS_FEATURES` empty, the live CLI surface reports
`toolsRegistered: 52` because these three diagnostic tools are gated behind
`experimental-tools`:

- `memphis_chain_query`
- `memphis_providers`
- `memphis_system_info`

That `52` runtime count is expected and does not contradict the `55` source
parity audit.

## Phase 3.2 Tightening

The audit initially extracted every quoted `memphis_*` string in each source
file. That was useful as a first drift gate but could hide false confidence if
a tool name appeared only in comments, docs, or helper text.

It now extracts names only from binding points:

- registry keys in `TOOL_REGISTRY`
- executor `buildTool({ name })`
- MCP `server.registerTool(name)`

So `ta15-tool-surface-parity` now means: the source registry, executable
in-process bindings, and MCP registration bindings agree on the tool set.

## Phase 3.3 Schema Parity

Added `src/gateway/tool-schema-audit.ts` and doctor check
`ta16-tool-schema-parity`.

The audit compares registry Zod input schema keys against the in-process
executor JSON schema keys with all feature-flagged tools enabled. It ignores
`approval_request_id` because approval transport is not a model-facing argument.

Initial drift found and fixed:

- `memphis_repair`: executor exposed `force`; registry did not.
- `memphis_self_modify`: registry exposed `plan_id` + `step_idx`; executor
  schema/validator did not.

Current result:

- Checked tools: 55
- Mismatches: 0
- Missing registry schemas: 0
- Missing executor schemas: 0

## Phase 3.4 MCP Schema Parity

Extended `ta16-tool-schema-parity` to include live MCP registration schemas by
instantiating `createMemphisMcpServer(...)._registeredTools`. The check now
compares schema keys across:

- registry Zod schemas
- in-process executor JSON schemas
- MCP Zod schemas

MCP drift found and fixed:

- `memphis_self_modify`: MCP exposed neither `plan_id` nor `step_idx`; both now
  pass through to `runMemphisSelfModify` like the registry/executor surfaces.

Current result:

- Checked tools: 55
- Mismatches: 0
- Missing registry schemas: 0
- Missing executor schemas: 0
- Missing MCP schemas: 0

This is key-level parity. It proves the same argument names are available
across the three tool surfaces. It does not yet prove exact type/required-field
equivalence.

## Phase 3.5 Required-Field Parity

Extended `ta16-tool-schema-parity` again to compare required/optional status
for every schema key across registry, executor, and MCP.

Implementation details:

- Registry and MCP required fields are extracted from Zod object shapes with
  `fieldSchema.isOptional()`.
- Executor required fields are extracted from JSON schema `required`.
- `approval_request_id` remains ignored as transport-level approval metadata,
  not a model-facing tool argument.

Current result:

- Checked tools: 55
- Key mismatches: 0
- Required-field mismatches: 0
- Missing registry schemas: 0
- Missing executor schemas: 0
- Missing MCP schemas: 0

Doctor now reports: `checked=55; schema keys and required fields aligned`.

## Phase 3.6 Coarse Type Parity

Extended `ta16-tool-schema-parity` to compare coarse field types across
registry, executor, and MCP:

- `string`
- `number`
- `boolean`
- `array`
- `object`
- `union`
- `unknown`

The audit normalizes Zod wrappers that do not change the tool-facing coarse
contract:

- optional/default/nullable/catch wrappers unwrap to their inner type;
- `ZodPipe`/`ZodPipeline` unwrap to the output type;
- discriminated unions made entirely of object variants normalize to `object`.

Initial coarse type drift found by the stricter audit:

- `memphis_case_append.entry`: MCP represented this as a discriminated union of
  object variants; registry/executor represented the argument as object.
- `memphis_loop_step.action`: same pattern.
- `memphis_cognitive_mode_set.mode`: MCP represented this as `ZodPipe` ending
  in enum; registry/executor represented it as string.

These were semantically equivalent wrapper differences, so the audit was
normalized rather than weakening any tool schema.

Current result:

- Checked tools: 55
- Key mismatches: 0
- Required-field mismatches: 0
- Coarse type mismatches: 0
- Missing registry schemas: 0
- Missing executor schemas: 0
- Missing MCP schemas: 0

Doctor now reports:
`checked=55; schema keys, required fields, and coarse types aligned`.

## Phase 4.1 Registry-Derived Executor Schemas

Started the actual deduplication step instead of only auditing drift.

Added `src/gateway/tool-json-schema.ts`:

- derives provider/executor JSON Schema from `TOOL_REGISTRY[*].inputSchema`
  using Zod 4 `z.toJSONSchema`;
- removes transport-only `approval_request_id` by default so model-facing tool
  signatures do not expose approval plumbing;
- allows per-field descriptions to be layered onto generated schema so the
  registry remains the structural source of truth without making model-facing
  tool descriptions worse.

First executor tools moved to registry-derived schemas:

- `memphis_case_append`
- `memphis_case_query`

Why these first:

- the registry has richer Zod structure for these payloads than the previous
  executor `{ type: object }` shorthand;
- both handlers already validate the top-level argument as an object, so this
  change improves the provider-facing contract without changing execution
  behavior;
- `ta16-tool-schema-parity` remains the guard against accidental drift while
  the remaining executor schemas are migrated in batches.

Also updated stale comments that still described schema rollout as a 5-tool /
37-tool pilot. Current truth is: all 55 registry tools expose `inputSchema`.

## Phase 4.2 Tier-0 Executor Schema Batch

Moved five more high-traffic tier-0 executor schemas to
`buildRegistryInputJsonSchema()`:

- `memphis_journal`
- `memphis_recall`
- `memphis_search`
- `memphis_decide`
- `memphis_health`

Notes:

- `memphis_health` now derives an empty model-facing schema from the registry
  because its only registry field is transport-only `approval_request_id`.
- `memphis_recall.limit` and `memphis_search.limit` now preserve registry JSON
  Schema integer constraints (`exclusiveMinimum=0`, `maximum=50`) in the
  executor provider-facing schema.
- `ta16` coarse type parity normalizes JSON Schema `integer` to coarse
  `number`; exact integer-vs-number constraint parity remains a later, stricter
  check.
- Existing runtime validator behavior was not changed in this batch.

## Phase 4.3 Executor Schema Deduplication Complete

Completed the remaining in-process executor migration. Every
`inputSchema` in `src/gateway/tool-executor.ts` now derives from
`TOOL_REGISTRY[*].inputSchema` through `buildRegistryInputJsonSchema(...)`.

Moved the remaining executor schema groups:

- diagnostic/runtime tools:
  - `memphis_kartograf`
  - `memphis_slo_status`
  - `memphis_repair`
  - `memphis_chain_query`
  - `memphis_providers`
  - `memphis_system_info`
  - `memphis_presence`
- memory/config/control tools:
  - `memphis_soul_read`
  - `memphis_soul_write`
  - `memphis_config_show`
  - `memphis_config_set`
  - `memphis_config_reload`
  - `memphis_cognitive_mode_set`
  - `memphis_restart`
  - `memphis_self_describe`
- code/fs/network/build tools:
  - `memphis_web_fetch`
  - `memphis_code_read`
  - `memphis_grep`
  - `memphis_glob`
  - `memphis_git`
  - `memphis_test`
  - `memphis_deploy`
  - `memphis_cron`
  - `memphis_exec_analyze`
  - `memphis_exec`
  - `memphis_self_modify`
  - `memphis_fs_write`
  - `memphis_fs_ops`
  - `memphis_web_search`
  - `memphis_brave_search`
  - `memphis_media_ingest`
  - `memphis_package`
  - `memphis_db`
  - `memphis_build`
  - `memphis_health_check`
- self-plan and skill tools:
  - `memphis_self_plan_create`
  - `memphis_self_plan_get`
  - `memphis_self_plan_advance`
  - `memphis_self_plan_cancel`
  - `memphis_self_review`
  - `memphis_self_pr_open`
  - `memphis_self_deploy_verify`
  - `memphis_skill_list`
  - `memphis_skill_show`
  - `memphis_skill_create`
  - `memphis_skill_validate`
  - `memphis_skill_install`

Current executor truth:

- `rg "inputSchema: \\{" src/gateway/tool-executor.ts` returns no matches.
- Executor schemas are no longer a separate hand-maintained source of truth.
- Runtime `validateInput` and `execute` logic were intentionally not changed.
- MCP still contains manual Zod registration schemas, guarded by `ta16`.

Next phase should either:

1. add stricter constraint parity checks now that executor JSON Schema is
   generated from registry; or
2. start deriving MCP registration schemas from registry in small batches.

## Phase 4.4 Constraint Drift Observation

Added an observational constraint layer to `ta16-tool-schema-parity`.

The audit now converts all three schema sources to JSON Schema before comparing
constraints:

- registry Zod schemas via `z.toJSONSchema`;
- executor model-facing JSON Schema directly;
- MCP registered Zod schemas via `z.toJSONSchema`.

Compared constraint signals include:

- `enum` and `const`;
- `format`;
- numeric bounds (`minimum`, `exclusiveMinimum`, `maximum`,
  `exclusiveMaximum`);
- string bounds (`minLength`, `maxLength`);
- array bounds (`minItems`, `maxItems`);
- `additionalProperties`;
- nested object and array item paths such as `targets[].url`.

Normalization intentionally ignores Zod/JSON-Schema noise:

- transport-only `approval_request_id`;
- safe-integer bounds emitted by `.int()`;
- integer `.positive()` (`exclusiveMinimum=0`) as equivalent to
  `minimum=1`.

Current behavior is observational:

- `constraintMismatches` is included in the report and doctor metadata.
- `constraintMismatches` does **not** make `report.ok=false` yet.
- Doctor detail reports
  `constraintMismatches(observed)=<n>` while keeping `ta16` pass if keys,
  required fields, and coarse types are aligned.

Initial observed result after executor deduplication:

- Checked tools: 55
- Key mismatches: 0
- Required-field mismatches: 0
- Coarse type mismatches: 0
- Observed constraint mismatches: 60

Examples of drift now visible:

- `memphis_deploy.healthUrl`: registry/executor allow string; MCP requires
  URI.
- `memphis_health_check.targets[].url`: registry/executor require URI; MCP
  only requires non-empty string.
- `memphis_grep.pattern`: registry/executor require non-empty string; MCP also
  caps length at 500.
- `memphis_loop_step.action`: registry/executor expose a generic object shape;
  MCP exposes variant-level details through a discriminated union.

Phase 4.5 resolved the observed drift rather than allowlisting it:

- simple numeric/string/URI bounds were promoted or aligned in
  `TOOL_REGISTRY` and `src/mcp/server.ts`;
- `memphis_soul_write` now uses shared `soulMemoryUpdateSchema` in registry and
  MCP;
- `memphis_loop_step` now uses shared loop request schemas
  (`soulLoopStateSchema`, `soulLoopActionSchema`, `soulLoopLimitsSchema`) in
  registry and MCP;
- `memphis_case_append` now uses shared `caseEntrySchema`, and case query
  filtering uses shared `caseTypeSchema`;
- the audit normalizes object-only JSON Schema `oneOf`/`anyOf` unions to coarse
  `object` so discriminated-union encoding does not look like behavior drift.

Current result after unification:

- Checked tools: 55
- Key mismatches: 0
- Required-field mismatches: 0
- Coarse type mismatches: 0
- Observed constraint mismatches: 0

Future drift should still be classified as one of:

- registry should adopt the stricter MCP constraint;
- MCP should be loosened to registry;
- difference is intentional and needs an explicit allowlist/explanation;
- MCP schema should be generated from registry once the intended contract is
  clear.

## Verification

Passed:

- `npx vitest run tests/unit/tool-surface-audit.test.ts tests/unit/cli.ask-doctor.test.ts tests/doctor-v2.test.ts tests/unit/tool-registry.test.ts tests/unit/tool-registry-descriptors.test.ts`
- `npx vitest run tests/unit/tool-surface-audit.test.ts tests/unit/cli.ask-doctor.test.ts tests/doctor-v2.test.ts`
- `npx tsc -p tsconfig.json`
- `memphis doctor --json`
- `npx vitest run tests/unit/tool-surface-audit.test.ts tests/unit/cli.ask-doctor.test.ts tests/doctor-v2.test.ts`
- `npx tsc -p tsconfig.json`
- `npx vitest run tests/unit/tool-schema-audit.test.ts tests/unit/tool-surface-audit.test.ts tests/unit/cli.ask-doctor.test.ts tests/doctor-v2.test.ts tests/unit/tool-registry.test.ts`
- `node -e "import('./dist/gateway/tool-schema-audit.js').then(m=>console.log(JSON.stringify(m.buildToolSchemaAuditReport(process.env), null, 2)))"`
- `npx vitest run tests/unit/tool-json-schema.test.ts tests/unit/tool-schema-audit.test.ts tests/unit/tool-surface-audit.test.ts`
- `npx vitest run tests/unit/tool-json-schema.test.ts tests/unit/tool-schema-audit.test.ts tests/unit/tool-surface-audit.test.ts tests/unit/tool-registry-schema.test.ts`
- `npx vitest run tests/unit/tool-json-schema.test.ts tests/unit/tool-schema-audit.test.ts tests/unit/tool-surface-audit.test.ts tests/unit/tool-registry-schema.test.ts tests/unit/cli.ask-doctor.test.ts tests/doctor-v2.test.ts`
- `npx tsc -p tsconfig.json`
- `npx vitest run tests/unit/tool-schema-audit.test.ts`
- `npx tsc -p tsconfig.json`
- `npm run build`
- `memphis doctor --json`
- `npx vitest run tests/unit/tool-schema-audit.test.ts tests/unit/tool-surface-audit.test.ts tests/unit/cli.ask-doctor.test.ts tests/doctor-v2.test.ts`
- `npx tsc -p tsconfig.json`
- `node -e "import('./dist/gateway/tool-schema-audit.js').then(m=>console.log(JSON.stringify(m.buildToolSchemaAuditReport(process.env), null, 2)))"`
- `memphis doctor --json`
- `npx vitest run tests/unit/tool-schema-audit.test.ts`
- `npx tsc -p tsconfig.json`
- `node -e "import('./dist/gateway/tool-schema-audit.js').then(m=>console.log(JSON.stringify(m.buildToolSchemaAuditReport(process.env), null, 2)))"`
- `npx vitest run tests/unit/tool-schema-audit.test.ts tests/unit/tool-surface-audit.test.ts tests/unit/cli.ask-doctor.test.ts tests/doctor-v2.test.ts`
- `memphis doctor --json`
- `npx vitest run tests/unit/tool-json-schema.test.ts tests/unit/tool-schema-audit.test.ts tests/unit/tool-registry-schema.test.ts`
- `npx tsc -p tsconfig.json`
- `node -e "import('./dist/gateway/tool-schema-audit.js').then(m=>console.log(JSON.stringify(m.buildToolSchemaAuditReport(process.env), null, 2)))"`
- `memphis doctor --json`
- `npx vitest run tests/unit/tool-json-schema.test.ts tests/unit/tool-schema-audit.test.ts tests/unit/tool-surface-audit.test.ts tests/unit/cli.ask-doctor.test.ts tests/doctor-v2.test.ts`
- `npx vitest run tests/unit/tool-json-schema.test.ts tests/unit/tool-schema-audit.test.ts tests/unit/tool-registry-schema.test.ts`
- `npx tsc -p tsconfig.json`
- `node -e "import('./dist/gateway/tool-schema-audit.js').then(m=>console.log(JSON.stringify(m.buildToolSchemaAuditReport(process.env), null, 2)))"`
- `memphis doctor --json`
- `npx vitest run tests/unit/tool-schema-audit.test.ts`
- `npx tsc -p tsconfig.json`
- `node -e "import('./dist/gateway/tool-schema-audit.js').then(m=>console.log(JSON.stringify(m.buildToolSchemaAuditReport(process.env), null, 2)))"`
- `npx vitest run tests/unit/tool-schema-audit.test.ts tests/unit/tool-surface-audit.test.ts tests/unit/cli.ask-doctor.test.ts tests/doctor-v2.test.ts`
- `memphis doctor --json`

Observed:

- `doctor` reports `ta15-tool-surface-parity` as pass.
- Detail: `registry=55; surfaces aligned: registry=55, inProcessExecutor=55, mcpServer=55`.
- `doctor` reports `ta16-tool-schema-parity` as pass.
- Detail: `checked=55; schema keys aligned`.
- `ta16` metadata: `missingRegistrySchema=[]`, `missingExecutorSchema=[]`,
  `missingMcpSchema=[]`, `mismatches=[]`.
- After Phase 3.5, detail is `checked=55; schema keys and required fields
  aligned`.
- `ta16` metadata also includes `requiredMismatches=[]`.
- After Phase 3.6, detail is `checked=55; schema keys, required fields, and
  coarse types aligned`.
- `ta16` metadata also includes `typeMismatches=[]`.
- After Phase 4.5, the live source audit reports
  `mismatches=0`, `required=0`, `types=0`, `constraints=0`.

## Phase 4.6 Runtime MCP Transport Policy

Source/tool parity is separate from whether the optional MCP-over-HTTP transport
is currently running. `src/mcp/server.ts` and the in-process executor can be
fully aligned even when no process listens on `MCP_PORT`.

Doctor now treats MCP HTTP as opt-in:

- `MEMPHIS_MCP_REQUIRED=false` or unset:
  - `t6-mcp-server` is a non-required warning when `:MCP_PORT` is not running;
  - detail says `optional HTTP MCP not running` and gives the exact
    `memphis mcp serve --transport http --port <port>` command.
- `MEMPHIS_MCP_REQUIRED=true`:
  - `t6-mcp-server` becomes required;
  - unreachable MCP HTTP is a hard fail with a start-or-disable fix.

This closes the confusing operator state where doctor reported
`MCP server: unreachable on :3001` even though Memphis had no enabled systemd
unit for MCP HTTP and the source-level MCP tool surface was already aligned.

## Phase 4.7 MCP Registry-Derived Schema Batch 1

First low-risk MCP handlers now derive their MCP input schema directly from
`TOOL_REGISTRY` instead of carrying a hand-maintained shape in
`src/mcp/server.ts`:

- `memphis_health`
- `memphis_self_describe`
- `memphis_slo_status`
- `memphis_presence`

Handlers remain unchanged. The only local narrowing is at the handler boundary
(`surface`, `actorId`, `windowDays`) because the MCP SDK passes generic
`Record<string, unknown>` arguments after schema validation.

Regression coverage:

- `tests/mcp/server.test.ts` starts the MCP server in-memory, calls
  `listTools()`, converts the matching `TOOL_REGISTRY` Zod schemas with
  `z.toJSONSchema()`, and verifies the first-batch MCP property keys match the
  registry-derived schema.
- `tests/unit/tool-surface-audit.test.ts` remains green for source/surface
  names.

Verification run:

- `npx vitest run tests/mcp/server.test.ts tests/unit/tool-surface-audit.test.ts`

Important current truth:

- The first MCP registry-derived batch is complete.
- Full global schema constraint parity is not complete in the live source.
  A direct `buildToolSchemaAuditReport(...)` still reports non-required drift
  outside this batch, including `memphis_repair.force`,
  `memphis_self_modify.plan_id/step_idx`, and multiple remaining constraint
  differences in older executor/MCP manual schemas.
- Therefore the next refactor should continue migrating handler-compatible MCP
  and executor schemas to registry-derived definitions in small batches, rather
  than treating global `ta16` constraint parity as permanently solved.

## Phase 4.8 Schema Drift Batch 2

The two explicit key/type drifts called out after Phase 4.7 are resolved:

- `memphis_repair.force`
  - `TOOL_REGISTRY.memphis_repair.inputSchema` now declares `force?: boolean`.
  - MCP derives `memphis_repair` input schema from `TOOL_REGISTRY`.
  - Executor and MCP keep the existing behavior: omitted `force` remains falsey.
- `memphis_self_modify.plan_id` / `step_idx`
  - Executor JSON schema now exposes the optional step-aware fields.
  - Executor validation passes `plan_id` and a non-negative integer `step_idx`
    through to `runMemphisSelfModify`.
  - MCP derives `memphis_self_modify` input schema from `TOOL_REGISTRY` and
    forwards the optional step-aware fields to the tool implementation.

Regression coverage:

- `tests/mcp/server.test.ts` verifies that `memphis_repair` and
  `memphis_self_modify` MCP schemas are registry-derived alongside the Phase
  4.7 tools.
- `tests/unit/tool-schema-audit.test.ts` now asserts the repaired Batch 2 tools
  have no key, coarse-type, or constraint drift.

Verification run:

- `npx vitest run tests/mcp/server.test.ts tests/unit/tool-surface-audit.test.ts tests/unit/tool-schema-audit.test.ts`
- `npm run typecheck`

Important current truth:

- Batch 2 is clean for `memphis_repair` and `memphis_self_modify`.
- Global constraint parity is still not complete. The remaining drift is mostly
  older manual executor/MCP JSON schema being less specific than registry Zod
  schema, plus a few intentional/undecided policy differences such as stricter
  MCP limits.

## Phase 4.9 Read/Search Schema Drift Batch 3

The high-use read/search tools are clean across registry, in-process executor,
and MCP:

- `memphis_recall`
- `memphis_search`
- `memphis_code_read`
- `memphis_brave_search`

Changes:

- MCP derives all four input schemas from `TOOL_REGISTRY`.
- Executor JSON schema now mirrors registry constraints for required strings,
  integer limits, line ranges, and ISO-2 country/language fields.
- Executor validation now rejects out-of-range integer limits and invalid
  two-character region/language codes before tool execution.

Limit policy remains unchanged:

- `memphis_recall` / `memphis_search`: public limit cap 50. `runMemphisRecall`
  also has an internal clamp at 100 for fallback fanout, so 1000 is not a
  current chat-tool contract.
- `memphis_brave_search`: cap 20.
- `memphis_code_read`: cap 2000 lines.

Regression coverage:

- `tests/mcp/server.test.ts` verifies registry-derived MCP schemas for the
  Phase 4.7, 4.8, and 4.9 tools.
- `tests/unit/tool-schema-audit.test.ts` asserts Phase 4.8 and Phase 4.9 tools
  have no key, coarse-type, or constraint drift.

Verification run:

- `npx vitest run tests/mcp/server.test.ts tests/unit/tool-surface-audit.test.ts tests/unit/tool-schema-audit.test.ts`
- `npm run typecheck`

Important current truth:

- Read/search batch is clean.
- Bulk memory browsing/export remains a separate feature decision. If the
  operator wants 1000+ results, implement a paginated/bulk read surface instead
  of increasing chat search result limits.

## Phase 4.10 Registry-Derived Executor Schema Batch 4

Executor/provider JSON schemas now use `buildRegistryInputJsonSchema(...)` for
the read/diagnostic batch instead of hand-maintaining equivalent JSON schema:

- `memphis_recall`
- `memphis_search`
- `memphis_code_read`
- `memphis_brave_search`
- `memphis_chain_query`
- `memphis_grep`
- `memphis_glob`

Changes:

- Executor schemas derive keys, required fields, types, and most constraints
  from `TOOL_REGISTRY`.
- Executor keeps model-facing property descriptions through
  `propertyDescriptions`.
- Executor validation remains explicit and mirrors registry integer/string
  constraints for the batch.

Intentional MCP policy drift retained:

- `memphis_chain_query.offset`: MCP caps offset at 1000; registry/executor only
  require `>= 0`.
- `memphis_glob.pattern`: MCP caps pattern length at 300.
- `memphis_grep.pattern`: MCP caps pattern length at 500.
- `memphis_grep.context`: MCP caps context at 10.

These are transport hardening constraints, not source-of-truth omissions. Do
not remove them without an explicit MCP policy decision.

Regression coverage:

- `tests/unit/tool-json-schema.test.ts` verifies Batch 4 executor schemas call
  `buildRegistryInputJsonSchema(...)`.
- `tests/unit/tool-schema-audit.test.ts` asserts Batch 4 has no key/type drift
  and only the listed intentional MCP constraint drift.

Verification run:

- `npx vitest run tests/unit/tool-json-schema.test.ts tests/unit/tool-schema-audit.test.ts tests/unit/tool-surface-audit.test.ts tests/mcp/server.test.ts`
- `npm run typecheck`

## Remaining Follow-Ups

- Continue replacing MCP manual registration with registry-derived registration
  where the handler shape allows it.
- Reconcile the known global schema drift before using global constraint parity
  as a hard health claim again.
- Target structured-memory tools next:
  `memphis_case_append`, `memphis_case_query`, and `memphis_soul_write`.
- Decide whether CLI help should consume `TOOL_REGISTRY` directly for all
  operator-facing command descriptions.

## Public Chat Runtime Boundary Fix (2026-06-15)

Observed production-quality bug:

- `memphis-public-chat-gateway` forwarded website chat to
  `/v1/chat/generate` with `mode: canonical`.
- Canonical HTTP chat enters `runTurnRuntime` with the `http.chat.generate`
  surface, memory client, tool executor, and cognitive prelude.
- For public website chat this violates the intended boundary: tier-0 public
  chat should be no-tools/no-vault/no-fs and should not leak internal runtime
  status unless intentionally exposed.
- Symptom in logs: a simple public `/chat` request called `memphis_health`,
  loaded ModelC context, and took about 25s.

Fix:

- Added `src/infra/public-chat-contract.ts` as the public gateway contract.
- Public gateway now sends `mode: provider-only`, no `tools`, and a public
  message contract with system + user messages.
- The public system prompt defines Memphis as the local-first,
  operator-supervised AI runtime from `memphis-v5.pl`, says not to interpret
  "Memphis" as the city unless the user asks for the city, and mirrors the
  user's language.
- This keeps the public surface as a rate-limited provider gateway while the
  operator surfaces retain canonical runtime/tool behavior.

Verification:

- `npx vitest run tests/unit/public-chat-contract.test.ts tests/unit/http-routes-chat.test.ts`
- `npm run typecheck`
- `npx tsc -p tsconfig.json`
- Restarted `memphis-public-chat.service`.
- Post-fix public `/chat` completed in about 4.5s and core logs showed no
  `tool executed` and no ModelC prelude for that request.
- Identity smoke after restart:
  `Czym jest Memphis? Odpowiedz jednym zdaniem.` returned a Polish answer
  describing Memphis as the local operator-supervised AI runtime, not the city.

Refactor implication:

- Public website chat is not the same surface as operator HTTP chat.
- If future work needs public memory, tools, or retrieval, create an explicit
  `public.chat` policy/surface instead of reusing `http.chat.generate`.

## Soul/Journal Write Path Fix (2026-06-16)

Observed runtime bug:

- Memphis repeatedly failed `memphis_soul_write` from the Telegram/operator
  loop because MiniMax tool calls encoded array fields as objects:
  `user.languages`, `self.learnings`, and `context.recentDecisions`.
- Strict schema rejection was correct, but operationally this made Memphis
  unable to save otherwise valid soul updates.
- `runMemphisSoulWrite` updated `soul-memory.json` and wrote best-effort case
  entries, but did not append an audit block to the `soul` chain. The chain
  catalog says soul-memory evolution is audited there, so the implementation
  and map were out of sync.
- Some log lines such as `recalled_memory_blocked` are not journal write
  failures; they mean prompt-boundary rejected recalled memory before putting
  it back into a turn prompt.

Fix:

- Added a narrow `memphis_soul_write` normalizer for object-encoded array
  fields before Zod validation. Scalar strings are still rejected for list
  fields, and unknown keys remain rejected by the strict schema.
- `runMemphisSoulWrite` now appends a `soul.memory_update` `system_event`
  block to the `soul` chain for every non-empty update.
- If the soul-chain audit append fails after the memory file update, the tool
  returns `auditWarning` instead of hiding the error.

Verification:

- `npx vitest run tests/mcp/soul-tools.test.ts tests/unit/in-process-tool-executor.test.ts tests/unit/soul-memory.test.ts tests/unit/durable-memory.test.ts`
- `npm run typecheck`
- `npx tsc -p tsconfig.json`
- Restarted `memphis.service`.
- `memphis health` reports `runtimeStatus: healthy`, controlled first-run
  `initialized-clean`, and chain integrity `invalid: 0`.
- `memphis chain verify --chain journal`, `--chain soul`, and `--chain cases`
  all returned `ok: true`.

## Turn Persistence Degradation Taxonomy (2026-06-16)

Observed runtime bug:

- `TurnPersistenceStatus.errors` mixed prompt/input guards, surface-policy
  blocks, real write failures, and post-response cognitive failures in one
  flat list.
- Gateway logs therefore reported `recalled_memory_blocked` as generic
  "persistence degraded", which looked like journal write failure even though
  it only meant recalled memory was rejected before prompt injection.

Fix:

- Kept the legacy flat `errors` array for compatibility.
- Added categorized arrays:
  `inputBlocks`, `policyBlocks`, `writeFailures`, and `cognitiveFailures`.
- `chat-loop` logs all four categories when a turn is degraded.

Verification:

- `npx vitest run tests/unit/turn-runtime.test.ts tests/unit/memory-client.test.ts tests/unit/in-process-tool-executor.test.ts tests/mcp/soul-tools.test.ts`
- `npm run typecheck`
- `npx tsc -p tsconfig.json`

## Backup Readiness Fix (2026-06-16)

Observed runtime bug:

- `memphis backup create` could successfully write a `.tar.gz` archive and
  then fail while finalizing it because Node's `execFileSync('tar', ['-tzf',
  ...])` returned `spawnSync tar EPERM` in the current runtime environment.
- On that path `listArchiveContents` treated the real tarball as if it might
  be Memphis' gzip+JSON fallback archive and tried to `JSON.parse` tar bytes,
  producing the misleading error `Unexpected token '.', "./\0\0..." is not
  valid JSON`.
- The failure left a top-level orphan archive with no checksum and no manifest
  entry, so `backup list --verify` correctly reported corrupt backup state.

Fix:

- Added safe fallback-archive detection: gzip payloads are only parsed as
  fallback JSON when they look like JSON and validate `format:
  memphis-backup-v1`.
- If system tar creates an archive but Node cannot list it, backup creation now
  replaces the archive with Memphis' fallback format before writing checksum
  and manifest metadata. This keeps backup create/verify/restore functional in
  restricted runtimes.
- `listArchiveContents` now reports a clear tar-listing error instead of
  leaking JSON parse noise for non-fallback archives.
- `.env-redacted` cleanup is centralized so accepted tar warnings and fallback
  conversion do not leave the temporary redacted file in the data dir.

Runtime cleanup:

- Created and verified a fresh active backup:
  `codex-backup-fallback-fix-2026-06-16-2026-06-16-10-26.tar.gz`.
- Moved the incomplete failed attempt and stale unverifiable top-level archive
  to `/home/memphis/.memphis/backups/failed/` instead of deleting them.

Verification:

- `npx vitest run tests/backup.test.ts tests/unit/backup-env-redacted.test.ts tests/integration/backup-list-verify.test.ts`
- `npm run typecheck`
- `npx tsc -p tsconfig.json`
- `memphis backup create --tag codex-backup-fallback-fix-2026-06-16 --json`
- `memphis backup verify codex-backup-fallback-fix-2026-06-16-2026-06-16-10-26.tar.gz --json`
- `memphis backup list --verify --json` returned `total=1`, `valid=1`,
  `corrupt=0`.
- `memphis health` remained `runtimeStatus: healthy`, chain integrity
  `invalid: 0`.

## SLO Telemetry Truth Fix (2026-06-16)

Observed runtime/map bug:

- A Telegram report claimed SLO was "All green" with old metric names such as
  `tool_success_rate`, `p95_latency_ms_overall`,
  `vault_decrypt_error_rate`, `chain_append_throughput`, and
  `embed_index_health`.
- Current code has no implementation for those names. The active
  `memphis_slo_status` path uses `src/observability/slo-evaluator.ts` and
  implements four SLOs: `p99_turn_latency_ms`, `confabulation_rate`,
  `provider_error_rate`, and `tool_error_rate`.
- Registry help text still advertised the old SLO contract, so the model had
  prompt-level authority to describe metrics the runtime did not compute.
- The evaluator also marked tiny sample sets as `pass`, which let a handful of
  successful calls look like meaningful monitoring.

Fix:

- Updated `memphis_slo_status` help text to list only implemented SLOs.
- Added a default minimum sample floor of 10 to the evaluator. Below that, a
  computed value is returned but status is `unavailable` with reason
  `insufficient samples`, never `pass`.
- `tool_error_rate` now counts both span-level failures (`status=error`) and
  logical tool-result failures (`tool.output.shape=error`). Tool calls that
  execute successfully but return an error payload are still failed tool
  outcomes for SLO purposes.
- Future `tool.call` spans emitted by the agent loop now set span
  `status=error` when the tool returns a semantic error payload. This aligns
  the raw telemetry status with the SLO interpretation instead of forcing
  downstream evaluators to infer failure from attributes only.

Runtime observation after fix:

- Evaluating the current 7-day telemetry window scanned 270 spans.
- Current SLO truth is not green:
  - `p99_turn_latency_ms`: fail, value about 373s, samples 56.
  - `confabulation_rate`: fail, value about 5.36%, samples 56.
  - `provider_error_rate`: pass, value about 0.99%, samples 101.
  - `tool_error_rate`: fail, value about 25.45%, samples 110.

Verification:

- `npx vitest run tests/unit/slo-evaluator.test.ts tests/unit/tool-registry-descriptors.test.ts`
- `npx vitest run tests/unit/observability-instrument.test.ts tests/unit/slo-evaluator.test.ts`
- `npm run typecheck`
- `npx tsc -p tsconfig.json`
- Direct evaluator smoke:
  `npx tsx -e "import { evaluateSlos } from './src/observability/slo-evaluator.ts'; console.log(JSON.stringify(evaluateSlos({ windowDays: 7 }), null, 2));"`

Remaining refactor implication:

- `tests/unit/tool-registry.test.ts` still expects 52 tools and hidden preview
  tools, while the current runtime exposes 55 tools. That is a separate
  tool-surface registry drift and should be handled in the broader registry
  parity refactor, not hidden inside SLO telemetry work.

## End-of-Session Handoff Snapshot (2026-06-16 11:20 CEST)

Current operational state:

- `memphis.service` is enabled and active under systemd user.
- Runtime command: `/usr/bin/node /home/memphis/memphis/dist/infra/cli/index.js serve`.
- Service boot log shows Telegram channel gateway started with `tools:55`,
  provider `minimax`, model `MiniMax-M3`.
- `memphis health` reports `runtimeStatus: healthy`, first-run
  `initialized-clean`, chain integrity `invalid: 0`.
- Active chain counts at the final health check:
  `totalBlocks=1351`, `journal=130`, `soul=12`, `system=343`,
  `patterns=564`.
- Active backup state is clean:
  `memphis backup list --verify --json` returned `total=1`, `valid=1`,
  `corrupt=0`.
- Fresh valid backup:
  `/home/memphis/.memphis/backups/codex-backup-fallback-fix-2026-06-16-2026-06-16-10-26.tar.gz`.
- Failed/stale prior archives were moved, not deleted, to:
  `/home/memphis/.memphis/backups/failed/`.

Validated work completed in this session:

- Public chat gateway made provider-only and identity-prompted for Memphis as
  the local runtime, not the city.
- `memphis_soul_write` now tolerates provider object-encoded arrays for known
  soul list fields and writes an audit block to the `soul` chain.
- Turn persistence degradation now separates input blocks, policy blocks,
  write failures, and cognitive failures.
- Backup create/verify/list now survives Node tar-listing restrictions by
  falling back to Memphis' own gzip+JSON archive format.
- SLO telemetry contract now matches implemented SLOs and uses a minimum
  sample floor before returning `pass`.
- `tool_error_rate` now counts logical tool-result errors
  (`tool.output.shape=error`) in addition to span-level `status=error`.

Final verification commands run:

- `npx vitest run tests/mcp/soul-tools.test.ts tests/unit/in-process-tool-executor.test.ts tests/unit/soul-memory.test.ts tests/unit/durable-memory.test.ts`
- `npx vitest run tests/unit/turn-runtime.test.ts tests/unit/memory-client.test.ts tests/unit/in-process-tool-executor.test.ts tests/mcp/soul-tools.test.ts`
- `npx vitest run tests/backup.test.ts tests/unit/backup-env-redacted.test.ts tests/integration/backup-list-verify.test.ts`
- `npx vitest run tests/unit/slo-evaluator.test.ts tests/unit/tool-registry-descriptors.test.ts`
- `npm run typecheck`
- `npx tsc -p tsconfig.json`
- `memphis backup create --tag codex-backup-fallback-fix-2026-06-16 --json`
- `memphis backup verify codex-backup-fallback-fix-2026-06-16-2026-06-16-10-26.tar.gz --json`
- `memphis backup list --verify --json`
- `systemctl --user restart memphis.service`
- `systemctl --user status memphis.service`
- `memphis health`

Known remaining issues / next-session priorities:

1. Tool registry test isolation:
   - The shell environment currently has `MEMPHIS_FEATURES=experimental-tools`.
   - Therefore `getToolNames()` correctly exposes 55 tools including preview
     tools: `memphis_chain_query`, `memphis_providers`, and
     `memphis_system_info`.
   - `tests/unit/tool-registry.test.ts` assumes no feature flags but inherits
     process env, so it expects 52 tools and fails in this environment.
   - Proper fix: isolate `MEMPHIS_FEATURES` in that test or pass explicit
     empty env to `getToolNames({})` / `getToolsByTier(...)`; do not change
     runtime visibility to satisfy the stale test.

2. SLO failures are now real and should be investigated, not hidden:
   - `p99_turn_latency_ms` fail, about 373s over 56 turn samples.
   - `confabulation_rate` fail, about 5.36% over 56 turn samples.
   - `tool_error_rate` fail, about 25.45% over 110 tool samples.
   - Top slow turns are Telegram MiniMax-M3 turns from 2026-06-09,
     2026-06-10, and 2026-06-16; one turn has provider error 529.

3. Public chat is intentionally still lower priority than runtime truth:
   - public gateway contract exists and was smoke-tested earlier,
   - but Cloudflare/API deployment should wait until core runtime SLO/tool
     truth is stable.

## Code Inspection Tool Reliability Fix (2026-06-16)

Observed from SLO/tool-error drill:

- `memphis_grep` and `memphis_code_read` were a meaningful part of
  `tool_error_rate`.
- `memphis_code_read` only accepted absolute or `~/...` paths. The agent
  often calls code tools with repo-relative paths such as `src/foo.ts`; when
  process cwd is not the install root this resolves outside the sandbox and
  returns a false permission error.
- `memphis_grep` relied entirely on `rg`/`grep` child processes. In restricted
  runtimes these can fail with `spawnSync grep EPERM`, the same class of
  environment issue as the backup tar-listing failure.
- `memphis_grep` also did not defensively exclude generated/heavy directories
  from its default project search.

Fix:

- `memphis_code_read` now resolves relative paths against `~/memphis`.
- `memphis_grep` computes the project root at call time, not module import
  time, so tests/runtime HOME changes are respected.
- `memphis_grep` excludes generated/heavy directories by default:
  `node_modules`, `dist`, `target`, `data`, `logs`, `coverage`, app build dirs.
- If `rg`/`grep` execution is unavailable due `EPERM`/`EACCES`, `memphis_grep`
  falls back to a bounded in-process JS search with the same safety boundary
  and default directory exclusions.

Verification:

- `npx vitest run tests/unit/mcp-code-read-symlink.test.ts tests/unit/mcp-grep.test.ts tests/unit/observability-instrument.test.ts tests/unit/slo-evaluator.test.ts`
- `npm run typecheck`

## Case Query Schema Tolerance Fix (2026-06-16)

Observed from live tool-error/debug context:

- `memphis_case_query` could fail with
  `invalid_query_json: invalid type: string "30", expected usize`.
- The registry schema already says `query.limit` is a number, but the
  in-process gateway executor passed the raw `query` object directly to the
  case adapter.
- Result: MCP/registry truth and gateway runtime truth diverged. The model can
  naturally emit `"30"` while the Rust adapter correctly expects a numeric
  `usize`.

Fix:

- Added `normalizeCaseQueryForToolCall()` in `src/gateway/tool-executor.ts`.
- `memphis_case_query` now converts digit-only string limits like `"30"` to
  `30` at the TS tool boundary.
- The in-process executor now enforces the same practical limit range as the
  registry: integer `1..100`.
- Out-of-range values such as `"1000"` are rejected before reaching Rust, so
  Rust remains strict while the model-facing surface is tolerant where useful.

Verification:

- `npx vitest run tests/unit/in-process-tool-executor.test.ts tests/unit/mcp-tools-extended.test.ts`
- `npm run typecheck`
- `npx tsc -p tsconfig.json`

## Tool Registry Test Isolation Fix (2026-06-16)

Observed from the end-of-session handoff:

- The shell environment can legitimately set
  `MEMPHIS_FEATURES=experimental-tools`.
- With that flag, runtime-visible tools are 55, not 52, because preview
  diagnostic tools are enabled:
  `memphis_chain_query`, `memphis_providers`, `memphis_system_info`.
- `tests/unit/tool-registry.test.ts` used default `process.env` for stable
  registry-count assertions, so the test could fail depending on the caller's
  shell environment.

Fix:

- Stable registry assertions now pass an explicit empty env to
  `getToolNames()` and `getToolsByTier()`.
- Preview-tool assertions still pass an explicit feature env.
- Runtime behavior was not changed; only the test's assumptions were isolated.

Verification:

- `npx vitest run tests/unit/tool-registry.test.ts tests/unit/tool-registry-evolve.test.ts`

## SLO Status Self-Noise Fix (2026-06-16)

Observed from live `tool_error_rate` drill:

- In the last 24h, `memphis_slo_status` contributed tool errors even though
  the tool executed and returned a valid report.
- Root cause: `runMemphisSloStatus()` used top-level `ok: false` to mean
  "one or more SLOs failed".
- The generic tool-output classifier treats top-level `ok: false` as a
  semantic tool failure. That is correct for most tools, but wrong for an SLO
  reporting tool: a red SLO is report data, not a failed tool call.
- Result: SLO monitoring polluted `tool_error_rate` with its own red status.

Fix:

- `memphis_slo_status` now uses top-level `ok: true` when evaluation
  completes successfully.
- Added `allSlosPassing` for the actual monitored state.
- `failingSlos` remains the explicit list of red SLOs.

Verification:

- `npx vitest run tests/unit/slo-evaluator.test.ts tests/unit/observability-instrument.test.ts`
- `npm run typecheck`
- `npx tsc -p tsconfig.json`

## Self-Governance Capability Status (2026-06-16)

Goal:

- Give Memphis a canonical, tool-readable answer to:
  "can Memphis steer itself and preserve that ability?"
- Keep the default autonomy model supervised-operational:
  Memphis may diagnose and report readiness, but `canSelfModify` remains false
  unless the operator explicitly invokes the existing guarded
  `memphis_self_modify` path.

Implementation:

- Added `src/infra/runtime/self-governance.ts` as the pure decision layer.
- Added `memphis_self_governance_status` as a tier-0 read-only tool.
- Wired the tool into both the MCP server and the in-process executor.
- Added `selfGovernance` to the health payload.
- Self-governance aggregates:
  runtime first-run state, chain integrity, repair state, provider/fallback
  readiness, memory recall mode, backup readiness, scheduler posture, and SLO
  failures.
- Backup readiness checks both scheduled-backup process state and backup
  archives on disk, so a service restart does not erase the fact that a valid
  archive exists.

Current live smoke:

- `memphis health` remains `healthy`.
- `selfGovernance.capable=false` because historical 7-day SLOs still fail:
  `p99_turn_latency_ms`, `confabulation_rate`, `tool_error_rate`.
- `selfGovernance.canSelfRecover=true` because chains are clean, runtime repair
  is healthy, fallback path is ready, and a backup archive exists.
- `selfGovernance.canSelfModify=false` by design.

Verification:

- `npx vitest run tests/unit/self-governance.test.ts tests/unit/tool-registry.test.ts tests/unit/in-process-tool-executor.test.ts tests/mcp/server.test.ts`
- `npm run typecheck`
- `npx tsc -p tsconfig.json`
- Direct dist smoke for `runMemphisSelfGovernanceStatus()`
- Direct dist smoke for `buildHealthPayload(loadConfig()).selfGovernance`

## Fresh SLO Windows for Self-Governance (2026-06-16)

Observed after adding `selfGovernance`:

- A single 7-day SLO report can keep autonomy blocked long after the root
  causes were fixed.
- Memphis needs both historical trend context and fresh operational truth.

Fix:

- `evaluateSlos()` now accepts optional `windowHours` while preserving the
  existing `windowDays` API.
- `memphis_self_governance_status` and health self-governance now evaluate
  three windows: `1h`, `24h`, and `7d`.
- `selfGovernance.sloWindows` exposes compact per-window status, failing SLOs,
  sample count, and window bounds.
- Capability blockers come from fresh windows (`1h` and `24h`), while `7d`
  remains visible trend context and no longer blocks by itself.

Current live smoke:

- `1h`: `unavailable` with no samples.
- `24h`: `fail` for p99 latency, confabulation, provider error, and tool error.
- `7d`: `fail` for p99 latency, confabulation, and tool error.
- Therefore `selfGovernance.capable=false` is now grounded in fresh 24h data,
  not only historical 7d telemetry.

Verification:

- `npx vitest run tests/unit/self-governance.test.ts tests/unit/slo-evaluator.test.ts`
- `npm run typecheck`
- `npx tsc -p tsconfig.json`
- Direct dist smoke for `runMemphisSelfGovernanceStatus()`
