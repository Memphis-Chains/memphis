
Implementation Plan: Phases B–H (Complete Roadmap)
This document provides detailed implementation plans for phases B through H of the Memphis roadmap. Each phase builds on the previous, culminating in a fully capable, self‑sustaining agent. Phase A (Soul System) is assumed complete.

Phase B: Tiered Authorization & Trust Rules
Goal
Establish a granular permission model that allows the agent to act autonomously within operator‑defined boundaries. Introduce tiers (0, 1, 2), capability tags, and adaptive autonomy (quiet/balanced/paranoid modes) with auto‑approval rules.

Why Now
Without fine‑grained authorization, the agent either asks for approval too often (frustrating) or acts unsafely. This phase enables the agent to become a trusted assistant that learns which actions the operator approves.

Prerequisites
Phase A complete (soul manifest with mode, trust_rules).

Tool registry (temporary) from earlier phases (or we can add capability tags as we go).

Step 1: Add Tool Metadata – Capabilities & Tiers
Files:

src/tools/registry.ts (if exists; otherwise create a temporary map in tool-executor.ts).

Changes:

Extend tool definition to include:

tier: 0 | 1 | 2

capabilities: string[] – e.g., ['read', 'write', 'network', 'execute']

For each existing tool, assign appropriate tier and capabilities based on its function:

Tier 0: memphis_soul_*, memphis_recall, memphis_health, memphis_case_*

Tier 1: memphis_send, memphis_schedule, memphis_self_configure

Tier 2: memphis_self_modify (to be added later)

Ensure the tool lookup in tool-executor.ts returns this metadata.

Step 2: Authorization Module – src/gateway/authorization.ts
Create a new module with the following functions:

typescript
interface PermissionResult {
  allowed: boolean;
  reason?: string;
  needApproval?: boolean; // if allowed is false but can be approved
}

export async function checkPermission(
  toolName: string,
  context: ToolContext, // includes user, sessionId, etc.
  mode: 'quiet' | 'balanced' | 'paranoid'
): Promise<PermissionResult>

export async function recordApproval(
  toolName: string,
  context: ToolContext,
  approved: boolean,
  reason?: string
): Promise<void>
Logic:

Load soul manifest for mode and trust rules.

For each tool, check its tier against the mode:

quiet: auto‑approve Tier 0 and Tier 1 (unless explicitly denied by trust rules). Tier 2 requires approval.

balanced: auto‑approve Tier 0; Tier 1 may auto‑approve if matched by trust rules; Tier 2 always ask.

paranoid: always ask for approval, even Tier 0 (but can have exceptions).

Trust rules: stored in soul manifest as trust_rules array. Each rule: { tool: string, condition?: any, auto_approve: boolean }. Example: { tool: "memphis_send", condition: { channel: "telegram" }, auto_approve: true }.

If approval needed, return { allowed: false, needApproval: true }. The caller will handle prompting.

After approval, call recordApproval to write to case chain (e.g., Vocative entry for the call, Accusative for approval).

Step 3: Integrate Authorization into Tool Executor
File: src/gateway/tool-executor.ts

In executeTool, before calling the handler, call checkPermission.

If needApproval is true, use the existing withApprovalGate pattern (which will prompt via TUI/Telegram).

If approved, call recordApproval and then the tool.

If denied, return a user‑friendly error message.

Step 4: Mode & Trust Rules CLI
File: src/infra/cli/handlers/trust.handler.ts (new)

Add commands:

memphis trust list – show current rules.

memphis trust add <tool> [--auto-approve] [--condition <json>] – add rule.

memphis trust remove <tool> – remove.

memphis mode set <quiet|balanced|paranoid> – change mode.

These should update the soul manifest and write back atomically.

Step 5: Tests
Unit tests for permission logic (different modes, trust rules).

Integration test that simulates a tool call and checks approval flow.

CLI tests for trust command.

Verification:

bash
npm run typecheck
npm run lint
npx vitest run tests/unit/authorization.test.ts
npx vitest run tests/integration/authorization-flow.test.ts
Phase C: Safe Self‑Modification
Goal
Enable the agent to modify its own code safely, with snapshots, git branch isolation, test gate, and crash recovery. This is the core self‑evolution mechanism.

Why Now
Without self‑modification, the agent cannot improve itself or add new tools. It is the key differentiator.

Prerequisites
Phase B complete (tiered auth) – to enforce Tier 2 permission.

Soul manifest with evolution settings (e.g., snapshotBeforeEvolution, requirePassphraseForTier2).

Step 1: Evolve Session Manager – src/soul/evolve-session.ts
Create SQLite table evolve_sessions with columns: id, authorized_at, expires_at, intent, snapshot_id, branch, files_allowed_json, status, created_at, updated_at. Use existing SQLite client.

Implement:

createSession(intent, filesAllowed): EvolveSession

getSession(id)

updateStatus(id, status)

expireSessions() (cleanup)

Step 2: Snapshot & Rollback Manager – src/infra/recovery/rollback-manager.ts
Functions:

createSnapshot(description): string – creates a tarball/zip of src/ and data_dir/ with timestamp, stores in data_dir/snapshots/.

restoreSnapshot(snapshotId): Promise<void> – restores from tarball.

listSnapshots(): SnapshotInfo[]

pruneSnapshots(keep: number) – delete oldest.

Use existing fs and tar libraries.

Step 3: Git Branch Isolation – src/infra/git-utils.ts
Helper functions:

createBranch(branchName): Promise<void>

commitAll(message): Promise<string>

getCurrentBranch(): string

mergeBranch(branchName): Promise<void>

deleteBranch(branchName): Promise<void>

Assume the project is a git repository. Use simple-git library.

Step 4: Test Gate – src/infra/test-gate.ts
Run in the context of the evolve branch:

npm run typecheck

npm run lint

npm run test:ts (or relevant subset)

Return boolean pass/fail.

Step 5: MCP Tool – memphis_self_modify
File: src/mcp/tools/self-modify.ts

Input:

intent: string

files: string[] – list of files to change (relative to project root)

changes: Record<string, string> – map of file path to new content

Process:

Verify Tier 2 permission (using auth module). If needed, prompt for vault passphrase.

Create snapshot.

Create branch: evolve/{timestamp}-{slug}.

Apply changes (write new content to files).

Run test gate. If passes, commit and close session as committed. If fails, rollback to snapshot and close as rolled-back.

Return result (commit hash or rollback confirmation).

Step 6: Crash Recovery Guard
File: src/app/bootstrap.ts

On successful boot, write last-boot.json with timestamp.

On startup, read file; if it exists and age < 60s, and there is an active evolve session (status active), auto‑rollback to the snapshot recorded in the session.

Log the incident to chain (via memphis_case_append with Accusative entry).

Step 7: CLI Commands
memphis evolve status – list active/recent sessions.

memphis evolve rollback [id] – manual rollback.

memphis evolve log – show audit trail.

Step 8: Tests
Unit tests for session manager, snapshot, git helpers.

Integration test: simulate a code addition, verify commit/rollback.

Crash simulation: kill process mid‑evolve, restart, verify auto‑rollback.

Verification:

bash
npm run test:ts -- tests/integration/self-modify.test.ts
npm run test:rust # if any Rust changes
Phase D: Expanded Capabilities & Unified Onboarding
Goal
Provide all essential tools (16+), a single memphis init wizard, secret management, and Telegram CLI. This makes the agent practically useful.

Why Now
Without these, the agent is just a memory system; now it becomes a full assistant.

Prerequisites
Phases A, B, C complete (soul, auth, self‑modify) – though self‑modify is not strictly required for this phase.

Step 1: Implement Missing Tools (One by One)
Each tool follows the MCP pattern: src/mcp/tools/<name>.ts with handler, Zod schema, and registration in server.ts.

List:

memphis_vault_get (Tier 0) – read secret.

memphis_chain_query – query any chain (generic).

memphis_embed_store / memphis_embed_search – use Rust embeddings.

memphis_system_info – OS, memory, version.

memphis_providers – list available LLM providers.

memphis_send – send message via Telegram (Tier 1).

memphis_schedule – schedule a future action (store in SQLite, use cron‑like).

memphis_self_configure – change runtime config (Tier 1) – update .env or soul manifest.

Implementation notes:

memphis_vault_get uses existing vault-entry-store.ts.

memphis_embed uses rust-embed-adapter.ts.

memphis_schedule uses a simple in‑memory job queue (or SQLite) with a timer thread.

Step 2: Unified Onboarding – memphis init
File: src/infra/cli/commands/init.ts

Interactive wizard using inquirer (already used in setup.ts).

Steps:

Identity (agent name, owner name) – update soul manifest.
Provider selection (local‑fallback, shared‑llm, DeepSeek, etc.) – store API keys in vault, update .env.
Embeddings mode – ask for key if needed.
Telegram (optional) – BotFather token → vault → test.
Vault passphrase & recovery Q/A.
Generate soul manifest (re‑run ensureSoulManifest).
Write genesis journal block.
Replace existing setup.ts and configure.ts with a unified command.

Step 3: Secret Management CLI
File: src/infra/cli/handlers/secret.handler.ts

memphis secret set <key> <value> – add to vault and update .env with VAULT:key.

memphis secret get <key> – decrypt and show.

memphis secret list – list keys (not values).

memphis secret rotate <key> – re‑encrypt with new value.

Reuse vault-add and env-update logic.

Step 4: Telegram CLI
File: src/infra/cli/handlers/telegram.handler.ts

memphis telegram setup – interactive token entry, test, enable.

memphis telegram test – send a test message.

memphis telegram status – show connection state.

memphis telegram disable – turn off.

memphis telegram send <chatId> <msg> – manual send.

Step 5: Tests
Unit tests for each new tool (mocked dependencies).

Integration test for memphis init (using temp dir).

CLI tests for secret and telegram commands.

Verification:

bash
npm run test:ts -- tests/mcp/*.test.ts
npm run test:ts -- tests/integration/init-wizard.test.ts
Phase E: Webhooks & Basic Federation
Goal
Enable Memphis to react to external events (webhooks) and communicate with other agents on the local network (federation). This lays the groundwork for future multi‑agent collaboration.

Why Now
Webhooks allow integration with GitHub, Slack, etc. Federation enables swarm intelligence and shared memory.

Prerequisites
Phase D complete (tools, onboarding) – though many webhook features can be built independently.

Step 1: Webhook Ingress
Files: src/webhook/server.ts, src/webhook/webhook-manager.ts

Add HTTP routes in the main server (src/gateway/server.ts) for /webhook/{id}.

For each webhook, generate a unique ID and secret (stored in vault). Accept POST requests, verify signature (HMAC‑SHA256) if provided.

When triggered, inject the payload into the agent’s conversation (as a user message) or trigger a predefined workflow (via memphis_schedule or direct tool call).

Store webhook configurations in SQLite table webhooks.

Tools: memphis_webhook_create, memphis_webhook_delete, memphis_webhook_list.

Step 2: Agent Discovery
File: src/federation/discovery.ts

Use bonjour (mDNS) to broadcast presence on the local network. Advertise agent name, DID, capabilities, and HTTP port.

Listen for other agents and maintain a list in soul memory (discovered_peers).

Tool: memphis_discover_agents – return list of found peers.

Step 3: Agent Messaging
File: src/federation/messaging.ts

Define a simple JSON message format with from, to, type, payload, signature.

Use HTTP POST to each agent’s /agent/message endpoint (or use the chain as a message bus). For now, implement direct HTTP.

Tools: memphis_send_message – send a message to a specific agent; memphis_delegate – post a task to the chain (for others to pick up).

Step 4: MCP Client
File: src/mcp/client.ts

Load list of external MCP servers from soul manifest (mcpServers). Each server has a URL and optional token.

Provide a function callExternalTool(serverName, toolName, args) that forwards the request.

Register external tools dynamically so they appear in the agent’s tool list (with a prefix like external:).

Step 5: Tests
Webhook: create, trigger, verify injection.

Discovery: two instances on same machine, verify they find each other.

MCP client: mock an external server, call a tool.

Phase F: Self‑Healing & Resource Management
Goal
Keep Memphis responsive and prevent resource exhaustion through automatic pruning, heartbeat monitoring, and cleanup.

Why Now
Long‑running agent will accumulate data; this phase ensures stability.

Prerequisites
All previous phases (since pruning touches chains, snapshots, soul memory, etc.)

Step 1: Automatic Pruning
File: src/infra/cleanup.ts

Scheduled job (e.g., every 24 hours) that:

Rotates chains: if a chain file exceeds MAX_CHAIN_SIZE (e.g., 100 MB), close it, start a new one, compress old.

Deletes snapshots older than SNAPSHOT_RETENTION_DAYS (configurable in soul manifest).

Summarizes soul memory: call LLM to compress old entries (or simply delete entries older than SOUL_MEMORY_RETENTION_DAYS).

Expose memphis cleanup CLI to run manually.

Step 2: Heartbeat & Watchdog
File: src/infra/watchdog.ts

In a separate thread, periodically check:

Last tool call timestamp (store in memory, updated after each call). If > MAX_IDLE_SECONDS, log warning; if > STUCK_SECONDS, attempt graceful restart (if allowed).

Tool call timeouts (already in executor) – if a tool takes longer than TOOL_TIMEOUT, kill it.

Expose /health endpoint that returns last activity, session status, and resource usage.

Step 3: Cleanup CLI
Add memphis cleanup [--prune-chains] [--prune-snapshots] [--summarize-soul] to trigger specific tasks.

Step 4: Tests
Unit tests for pruning logic (mock file system).

Integration test: fill up chains, trigger rotation, verify new files.

Simulate a stuck tool and verify watchdog.

Phase G: Operator Experience & Polish
Goal
Deliver a smooth, intuitive interface for interacting with Memphis, including TUI enhancements, explainability, natural language queries, and analytics.

Why Now
Great UX makes Memphis a joy to use and increases operator trust.

Prerequisites
All previous phases (so TUI can display real data).

Step 1: Enhanced TUI Screens
Files: src/tui/screens/

Dashboard: Show agent name, mode, last actions, tool usage stats (from case chain).

Configure: Edit mode, trust rules, providers, secrets.

Telegram: Status, test, send.

Cases: Timeline of case entries, filterable by type/actor/entity.

Use existing TUI library (blessed or ink). Each screen should fetch data from the backend (through REST or direct calls).

Step 2: Explainability – memphis explain
File: src/infra/cli/handlers/explain.handler.ts

Takes a block index or a natural language reference (e.g., “last modification”). Retrieves the corresponding case entries and formats them into a human‑readable sentence.

Step 3: Natural Language → CaseQuery
File: src/mcp/tools/case-natural.ts

Tool memphis_case_natural that accepts a natural language query string.

Uses the LLM to generate a CaseQuery (maybe using a small prompt). Then executes memphis_case_query and returns results.

This can be exposed as a tool so the agent can answer questions like “What did I do yesterday?”

Step 4: Analytics
In the TUI, display statistics: most used tools, frequent actors, success/failure rates (from case chain entries with status).

Step 5: Tests
Manual testing of TUI screens.

Unit tests for natural language translation (mock LLM).

CLI tests for memphis explain.

Phase H: Integration & Final Testing
Goal
Ensure all components work together, with performance benchmarks and comprehensive documentation.

Why Now
Ready for release and real‑world use.

Step 1: End‑to‑End Tests
Use test/e2e/ directory. Tests should:

Bootstrap a fresh Memphis instance.

Run through a typical user session: init, soul memory, self‑modification, webhook trigger, etc.

Verify that all data persists correctly and the agent responds as expected.

Use temporary data directories and isolated environments.

Step 2: Performance Benchmarks
Measure:

Time to append a case entry.

Query latency for 10k entries.

Tool call overhead.

Memory usage.

Use benchmark scripts (already in benchmarks/).

Step 3: Documentation
Update README.md with new features.

Create user guide (docs/USER-GUIDE.md) covering installation, commands, modes, self‑modification, etc.

Update API reference.

Write troubleshooting section for common issues.

Step 4: Release Candidate
Create a release branch.

Run full test suite in CI.

Build packages (npm pack, cargo build).

Test installation on clean Linux/macOS machines.

Tag version.

Verification Commands (Final)
After each phase, run the appropriate verification commands. For the entire project, run:

bash
npm run lint
npm run typecheck
npm run format:check
npm run test:ts
npm run test:rust
npm run test:chaos
npm run test:ops-artifacts
All tests must pass. Any failures must be fixed before moving to the next phase.

This plan provides a step‑by‑step roadmap to complete Memphis. Each phase is self‑contained and can be implemented incrementally. Good luck!

Phase A is complete. Phase B is complete. Phase C is complete (251070c, 2026-03-22).

Phase C: Safe Self-Modification — implemented 2026-03-22 (commit 251070c)

  New files (6):
  - src/infra/storage/sqlite/repositories/evolve-session-repository.ts — SQLite CRUD for evolve sessions with status transitions, expiry, active session lookup
  - src/infra/git-utils.ts — Branch isolation helpers (create/switch/merge/delete, commit, stash) using child_process
  - src/infra/test-gate.ts — Runs typecheck → lint → test:ts with fail-fast, returns structured pass/fail
  - src/mcp/tools/self-modify.ts — Core orchestrator: session → snapshot → branch → apply → test gate → commit/rollback
  - src/infra/cli/handlers/evolve.handler.ts — CLI: memphis evolve status|rollback|log
  - tests/unit/evolve-session.test.ts + evolve-cli.test.ts + tool-registry-evolve.test.ts — 22 new tests

  Modified files (7):
  - src/infra/storage/sqlite/client.ts — Added evolve_sessions table (schema v3→v4)
  - src/gateway/tool-registry.ts — Added memphis_self_modify (tier 2, execute+write)
  - src/mcp/server.ts — Registered memphis_self_modify with approval gate
  - src/app/bootstrap.ts — Crash recovery guard: detects stale evolve sessions, auto-rollback on rapid restart
  - src/infra/cli/dispatcher.ts — Registered evolveCommandHandler
  - tests/integration/mcp-e2e.test.ts — Updated tool counts (11→12)
  - tests/unit/tool-registry.test.ts + sqlite.bootstrap.test.ts — Updated assertions

  Known issues (to fix before Phase D):
  - Path traversal vulnerability in self-modify file writes
  - RollbackManager only covers chains, not src/ files outside git
  - Passphrase gate (requirePassphraseForTier2) unimplemented
  - Crash recovery hardcodes 'main' branch
  - DB connection leaks in CLI/MCP handlers
  - Session state machine transitions unenforced

Phase A is complete. Here's a summary of everything implemented:

  New files (6):
  - src/soul/types.ts — Interfaces + Zod schemas for SoulManifest and SoulMemory
  - src/soul/manifest.ts — Generate/load/write manifest, ensureSoulManifest() preserves createdAt + DID
  - src/soul/memory.ts — Load/write/merge memory with deduplicating array append
  - src/soul/boot.ts — Boot detection, XML fragments (<soul_manifest>, <soul_memory>, <soul_boot>)                     - src/mcp/tools/soul.ts — runMemphisSoulRead + runMemphisSoulWrite with case chain audit trail                                                                                                                                            Modified files (5):                                                                                                  - src/mcp/server.ts — Registered memphis_soul_read + memphis_soul_write MCP tools                                    - src/gateway/agent-runtime.ts — Injects soul fragments into system prompt                                           - src/gateway/system-prompt.ts — Added soul tool instructions
  - src/app/bootstrap.ts — Calls ensureSoulManifest() on startup                                                       - src/infra/cli/handlers/storage.handler.ts — Added soul show/manifest/memory CLI commands                                                                                                                                                Tests (5 files, 55 tests):                                                                                           - tests/unit/soul-manifest.test.ts — 10 tests (generate, load, write, schema validation, createdAt/DID               preservation)                                                                                                        - tests/unit/soul-memory.test.ts — 14 tests (CRUD, deep merge, dedup, empty detection)                               - tests/unit/soul-boot.test.ts — 12 tests (XML fragments, boot detection, prompts)                                   - tests/mcp/soul-tools.test.ts — 9 tests (read sections, write + case chain recording, error resilience)             - tests/integration/mcp-e2e.test.ts — Updated tool counts (9→11, user tools 8→10)
We need to provide the user with the next phase implementation plan (Phase B: Tiered Authorization & Trust Rules) now that Phase A is complete. The user has confirmed Phase A is done and listed the implementations. We should now deliver Phase B plan in the same detailed style as the previous ones, ensuring it aligns with the current codebase.

We'll structure Phase B plan similarly: introduction, prerequisites, step-by-step implementation, critical files, testing, verification. We'll also incorporate the existing soul manifest and case chain integration.

We'll ensure the plan is concrete, referencing existing files (like soul manifest, tool executor, etc.) and follows the patterns already established.

Let's craft the response.

Implementation Plan: Phase B — Tiered Authorization & Trust Rules
Context
Phase A (Soul System) is complete. Memphis now has a persistent identity (soul-manifest.json), user memory (soul-memory.json), and the ability to record every soul mutation in the case chain. The agent knows what it can do (capabilities) and what the user prefers, but it still lacks a permission model. Currently, every action requires explicit approval, which becomes cumbersome for routine tasks. Phase B introduces a tiered authorization system with adaptive autonomy, allowing the agent to act more independently while staying within safe boundaries.

What Already Exists (Reuse)
Component	File	How to Use
Soul manifest	src/soul/manifest.ts	Contains mode and trust_rules (we'll add these fields now).
Soul memory	src/soul/memory.ts	Not directly needed for auth, but may store user preferences for mode selection.
Tool executor	src/gateway/tool-executor.ts	We'll intercept tool calls here to check permissions.
MCP tool registration	src/mcp/server.ts	We'll add tier/capability metadata to each tool’s definition.
Case chain	src/infra/storage/case-chain-adapter.ts	We'll record approvals as Vocative (invocation) and Accusative (approval decision).
CLI handlers	src/infra/cli/handlers/	We'll add new commands for trust rules and mode.
Implementation Steps
Step 1: Extend Soul Manifest Schema with Mode & Trust Rules
File: src/soul/types.ts

Add two new optional fields to SoulManifest (with defaults in ensureSoulManifest):

typescript
export interface SoulManifest {
  // ... existing fields ...
  mode?: 'quiet' | 'balanced' | 'paranoid'; // default: 'balanced'
  trustRules?: TrustRule[];                  // default: []
}

export interface TrustRule {
  tool: string;               // exact tool name or pattern (e.g., "memphis_send:*")
  condition?: Record<string, unknown>; // e.g., { channel: "telegram" }
  autoApprove: boolean;       // if true, skip approval
}
Update the Zod schema accordingly.

Also: Add these fields to generateSoulManifest() with sensible defaults.

Step 2: Add Tool Metadata (Tier & Capabilities)
File: src/gateway/tool-executor.ts (or src/tools/registry.ts if already refactored)

We need to store per‑tool metadata. Since the unified tool registry doesn’t exist yet, we'll augment the existing TOOL_DEFINITIONS object.

Define a new interface:

typescript
interface ToolMetadata {
  tier: 0 | 1 | 2;
  capabilities: string[]; // e.g., ['read', 'write', 'network', 'execute']
}
For each tool currently in TOOL_DEFINITIONS, assign appropriate values:

Tool	Tier	Capabilities
memphis_soul_read	0	['read']
memphis_soul_write	0	['write']
memphis_case_append	0	['write']
memphis_case_query	0	['read']
memphis_recall	0	['read']
memphis_journal	0	['write']
memphis_health	0	['read']
memphis_exec	2	['execute'] (will be elevated later)
memphis_send	1	['network', 'write']
memphis_schedule	1	['write']
memphis_self_configure	1	['write']
memphis_self_modify	2	['write', 'execute'] (to be added later)
We'll also keep a map toolMetadata accessible to the authorization module.

Step 3: Create Authorization Module – src/gateway/authorization.ts
Implement the core permission logic:

typescript
export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  needApproval?: boolean;
}

export async function checkPermission(
  toolName: string,
  context: ToolContext,
  rawEnv: NodeJS.ProcessEnv = process.env
): Promise<PermissionResult> {
  const manifest = ensureSoulManifest(rawEnv);
  const mode = manifest.mode ?? 'balanced';
  const trustRules = manifest.trustRules ?? [];

  // Find tool metadata
  const meta = toolMetadata[toolName];
  if (!meta) return { allowed: false, reason: `Unknown tool: ${toolName}` };

  // Tier 0 always allowed in all modes, but can be denied by trust rules.
  if (meta.tier === 0) {
    // Check for a deny rule (if we ever add negative rules)
    const denyRule = trustRules.find(r => r.tool === toolName && !r.autoApprove);
    if (denyRule) return { allowed: false, reason: `Denied by trust rule` };
    return { allowed: true };
  }

  // For Tier 1/2, mode matters
  if (mode === 'quiet') {
    // In quiet mode, Tier 1 is auto-approved unless a rule says otherwise
    if (meta.tier === 1) {
      const rule = trustRules.find(r => r.tool === toolName && r.autoApprove);
      if (rule) return { allowed: true };
      // If no rule, we auto-approve Tier 1 in quiet mode (but we may still need to record)
      return { allowed: true, needApproval: false }; // but we still record later
    }
    // Tier 2 always needs approval
    if (meta.tier === 2) {
      return { allowed: false, needApproval: true };
    }
  } else if (mode === 'balanced') {
    // Balanced: Tier 1 auto-approved only if trust rule matches; otherwise ask
    if (meta.tier === 1) {
      const rule = trustRules.find(r => r.tool === toolName && r.autoApprove);
      if (rule) return { allowed: true };
      return { allowed: false, needApproval: true };
    }
    // Tier 2 always ask
    if (meta.tier === 2) {
      return { allowed: false, needApproval: true };
    }
  } else if (mode === 'paranoid') {
    // Paranoid: always ask for approval (unless explicitly allowed by rule)
    const rule = trustRules.find(r => r.tool === toolName && r.autoApprove);
    if (rule) return { allowed: true };
    return { allowed: false, needApproval: true };
  }

  return { allowed: false, reason: `No rule for tier ${meta.tier} in mode ${mode}` };
}

export async function recordApproval(
  toolName: string,
  context: ToolContext,
  approved: boolean,
  reason?: string,
  rawEnv: NodeJS.ProcessEnv = process.env
): Promise<void> {
  // Record in case chain using the existing adapter
  const caseAdapter = getCaseChainAdapter(); // we'll need to inject or import
  const entry: CaseEntry = {
    case_type: 'accusative',
    subject: 'operator',
    verb: approved ? 'approved' : 'denied',
    object: `${toolName} ${reason ? `(${reason})` : ''}`,
  };
  await caseAdapter.appendCaseEntry(entry);
}
Note: The getCaseChainAdapter() function should be available from the DI container. We can also pass it via context.

Step 4: Integrate Authorization into Tool Executor
File: src/gateway/tool-executor.ts

In executeTool, before calling the handler:

typescript
const perm = await checkPermission(toolName, context);
if (!perm.allowed && !perm.needApproval) {
  return { error: perm.reason };
}
if (perm.needApproval) {
  // Use the existing approval gate (which may prompt via TUI/Telegram)
  const approved = await withApprovalGate(toolName, args, context);
  if (!approved) {
    await recordApproval(toolName, context, false, 'user denied');
    return { error: 'User denied approval' };
  }
  await recordApproval(toolName, context, true, 'approved via gate');
}
// ... proceed with tool execution
We'll need to make withApprovalGate available (it already exists in src/mcp/server.ts). We can refactor it into a shared module.

Step 5: Add CLI Commands for Trust Rules & Mode
File: src/infra/cli/handlers/trust.handler.ts (new)

Implement commands:

memphis trust list – prints manifest.trustRules formatted.

memphis trust add <tool> [--auto-approve] [--condition <json>] – adds a rule.

memphis trust remove <tool> – removes rule.

memphis mode set <quiet|balanced|paranoid> – updates manifest.mode.

These commands load the soul manifest, modify it, and write back (using writeSoulManifest).

Step 6: Update Bootstrap to Ensure Mode & Rules Exist
File: src/app/bootstrap.ts

In ensureSoulManifest, after generation, set default mode: 'balanced' and empty trustRules if not present.

Step 7: Test Suite
New test files:

tests/unit/authorization.test.ts – unit tests for permission logic (various modes, tiers, rules).

tests/integration/authorization-flow.test.ts – end‑to‑end test: call a Tier 1 tool, see approval prompt, approve, verify case chain entry.

tests/cli/trust-commands.test.ts – test CLI commands using exec against a temp data dir.

Update tests/integration/mcp-e2e.test.ts to ensure tool counts remain correct (no change expected).

Critical Files
File	Action
src/soul/types.ts	Add mode and trustRules fields
src/soul/manifest.ts	Ensure defaults in generation
src/gateway/tool-executor.ts	Add toolMetadata map, integrate checkPermission and recordApproval
src/gateway/authorization.ts	New – core logic
src/infra/cli/handlers/trust.handler.ts	New – CLI commands
src/app/bootstrap.ts	Set defaults
tests/unit/authorization.test.ts	New
tests/integration/authorization-flow.test.ts	New
tests/cli/trust-commands.test.ts	New
Verification
Run the standard checks:

bash
npm run typecheck
npm run lint
npm run format:check
npx vitest run tests/unit/authorization.test.ts
npx vitest run tests/integration/authorization-flow.test.ts
npx vitest run tests/cli/trust-commands.test.ts
npm run test:ts
All tests must pass.

Next Steps
After Phase B is complete, proceed to Phase C: Safe Self‑Modification, which will leverage the Tier 2 permission and trust rules to allow the agent to evolve its own code.

Implementation Plan: Phase B — Tiered Authorization & Trust Rules
Context
Phase A (Soul System) is complete. Memphis now has a persistent identity (soul-manifest.json), user memory (soul-memory.json), and the ability to record every soul mutation in the case chain. The agent knows what it can do (capabilities) and what the user prefers, but it still lacks a permission model. Currently, every action requires explicit approval, which becomes cumbersome for routine tasks. Phase B introduces a tiered authorization system with adaptive autonomy, allowing the agent to act more independently while staying within safe boundaries.

What Already Exists (Reuse)
Component	File	How to Use
Soul manifest	src/soul/manifest.ts	Contains mode and trust_rules (we'll add these fields now).
Soul memory	src/soul/memory.ts	Not directly needed for auth, but may store user preferences for mode selection.
Tool executor	src/gateway/tool-executor.ts	We'll intercept tool calls here to check permissions.
MCP tool registration	src/mcp/server.ts	We'll add tier/capability metadata to each tool’s definition.
Case chain	src/infra/storage/case-chain-adapter.ts	We'll record approvals as Vocative (invocation) and Accusative (approval decision).
CLI handlers	src/infra/cli/handlers/	We'll add new commands for trust rules and mode.
Implementation Steps
Step 1: Extend Soul Manifest Schema with Mode & Trust Rules
File: src/soul/types.ts

Add two new optional fields to SoulManifest (with defaults in ensureSoulManifest):

typescript
export interface SoulManifest {
  // ... existing fields ...
  mode?: 'quiet' | 'balanced' | 'paranoid'; // default: 'balanced'
  trustRules?: TrustRule[];                  // default: []
}

export interface TrustRule {
  tool: string;               // exact tool name or pattern (e.g., "memphis_send:*")
  condition?: Record<string, unknown>; // e.g., { channel: "telegram" }
  autoApprove: boolean;       // if true, skip approval
}
Update the Zod schema accordingly.

Also: Add these fields to generateSoulManifest() with sensible defaults.

Step 2: Add Tool Metadata (Tier & Capabilities)
File: src/gateway/tool-executor.ts (or src/tools/registry.ts if already refactored)

We need to store per‑tool metadata. Since the unified tool registry doesn’t exist yet, we'll augment the existing TOOL_DEFINITIONS object.

Define a new interface:

typescript
interface ToolMetadata {
  tier: 0 | 1 | 2;
  capabilities: string[]; // e.g., ['read', 'write', 'network', 'execute']
}
For each tool currently in TOOL_DEFINITIONS, assign appropriate values:

Tool	Tier	Capabilities
memphis_soul_read	0	['read']
memphis_soul_write	0	['write']
memphis_case_append	0	['write']
memphis_case_query	0	['read']
memphis_recall	0	['read']
memphis_journal	0	['write']
memphis_health	0	['read']
memphis_exec	2	['execute'] (will be elevated later)
memphis_send	1	['network', 'write']
memphis_schedule	1	['write']
memphis_self_configure	1	['write']
memphis_self_modify	2	['write', 'execute'] (to be added later)
We'll also keep a map toolMetadata accessible to the authorization module.

Step 3: Create Authorization Module – src/gateway/authorization.ts
Implement the core permission logic:

typescript
export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  needApproval?: boolean;
}

export async function checkPermission(
  toolName: string,
  context: ToolContext,
  rawEnv: NodeJS.ProcessEnv = process.env
): Promise<PermissionResult> {
  const manifest = ensureSoulManifest(rawEnv);
  const mode = manifest.mode ?? 'balanced';
  const trustRules = manifest.trustRules ?? [];

  // Find tool metadata
  const meta = toolMetadata[toolName];
  if (!meta) return { allowed: false, reason: `Unknown tool: ${toolName}` };

  // Tier 0 always allowed in all modes, but can be denied by trust rules.
  if (meta.tier === 0) {
    // Check for a deny rule (if we ever add negative rules)
    const denyRule = trustRules.find(r => r.tool === toolName && !r.autoApprove);
    if (denyRule) return { allowed: false, reason: `Denied by trust rule` };
    return { allowed: true };
  }

  // For Tier 1/2, mode matters
  if (mode === 'quiet') {
    // In quiet mode, Tier 1 is auto-approved unless a rule says otherwise
    if (meta.tier === 1) {
      const rule = trustRules.find(r => r.tool === toolName && r.autoApprove);
      if (rule) return { allowed: true };
      // If no rule, we auto-approve Tier 1 in quiet mode (but we may still need to record)
      return { allowed: true, needApproval: false }; // but we still record later
    }
    // Tier 2 always needs approval
    if (meta.tier === 2) {
      return { allowed: false, needApproval: true };
    }
  } else if (mode === 'balanced') {
    // Balanced: Tier 1 auto-approved only if trust rule matches; otherwise ask
    if (meta.tier === 1) {
      const rule = trustRules.find(r => r.tool === toolName && r.autoApprove);
      if (rule) return { allowed: true };
      return { allowed: false, needApproval: true };
    }
    // Tier 2 always ask
    if (meta.tier === 2) {
      return { allowed: false, needApproval: true };
    }
  } else if (mode === 'paranoid') {
    // Paranoid: always ask for approval (unless explicitly allowed by rule)
    const rule = trustRules.find(r => r.tool === toolName && r.autoApprove);
    if (rule) return { allowed: true };
    return { allowed: false, needApproval: true };
  }

  return { allowed: false, reason: `No rule for tier ${meta.tier} in mode ${mode}` };
}

export async function recordApproval(
  toolName: string,
  context: ToolContext,
  approved: boolean,
  reason?: string,
  rawEnv: NodeJS.ProcessEnv = process.env
): Promise<void> {
  // Record in case chain using the existing adapter
  const caseAdapter = getCaseChainAdapter(); // we'll need to inject or import
  const entry: CaseEntry = {
    case_type: 'accusative',
    subject: 'operator',
    verb: approved ? 'approved' : 'denied',
    object: `${toolName} ${reason ? `(${reason})` : ''}`,
  };
  await caseAdapter.appendCaseEntry(entry);
}
Note: The getCaseChainAdapter() function should be available from the DI container. We can also pass it via context.

Step 4: Integrate Authorization into Tool Executor
File: src/gateway/tool-executor.ts

In executeTool, before calling the handler:

typescript
const perm = await checkPermission(toolName, context);
if (!perm.allowed && !perm.needApproval) {
  return { error: perm.reason };
}
if (perm.needApproval) {
  // Use the existing approval gate (which may prompt via TUI/Telegram)
  const approved = await withApprovalGate(toolName, args, context);
  if (!approved) {
    await recordApproval(toolName, context, false, 'user denied');
    return { error: 'User denied approval' };
  }
  await recordApproval(toolName, context, true, 'approved via gate');
}
// ... proceed with tool execution
We'll need to make withApprovalGate available (it already exists in src/mcp/server.ts). We can refactor it into a shared module.

Step 5: Add CLI Commands for Trust Rules & Mode
File: src/infra/cli/handlers/trust.handler.ts (new)

Implement commands:

memphis trust list – prints manifest.trustRules formatted.

memphis trust add <tool> [--auto-approve] [--condition <json>] – adds a rule.

memphis trust remove <tool> – removes rule.

memphis mode set <quiet|balanced|paranoid> – updates manifest.mode.

These commands load the soul manifest, modify it, and write back (using writeSoulManifest).

Step 6: Update Bootstrap to Ensure Mode & Rules Exist
File: src/app/bootstrap.ts

In ensureSoulManifest, after generation, set default mode: 'balanced' and empty trustRules if not present.

Step 7: Test Suite
New test files:

tests/unit/authorization.test.ts – unit tests for permission logic (various modes, tiers, rules).

tests/integration/authorization-flow.test.ts – end‑to‑end test: call a Tier 1 tool, see approval prompt, approve, verify case chain entry.

tests/cli/trust-commands.test.ts – test CLI commands using exec against a temp data dir.

Update tests/integration/mcp-e2e.test.ts to ensure tool counts remain correct (no change expected).

Critical Files
File	Action
src/soul/types.ts	Add mode and trustRules fields
src/soul/manifest.ts	Ensure defaults in generation
src/gateway/tool-executor.ts	Add toolMetadata map, integrate checkPermission and recordApproval
src/gateway/authorization.ts	New – core logic
src/infra/cli/handlers/trust.handler.ts	New – CLI commands
src/app/bootstrap.ts	Set defaults
tests/unit/authorization.test.ts	New
tests/integration/authorization-flow.test.ts	New
tests/cli/trust-commands.test.ts	New
Verification
Run the standard checks:

bash
npm run typecheck
npm run lint
npm run format:check
npx vitest run tests/unit/authorization.test.ts
npx vitest run tests/integration/authorization-flow.test.ts
npx vitest run tests/cli/trust-commands.test.ts
npm run test:ts
All tests must pass.

Next Steps
After Phase B is complete, proceed to Phase C: Safe Self‑Modification, which will leverage the Tier 2 permission and trust rules to allow the agent to evolve its own code.


