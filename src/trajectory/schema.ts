/**
 * Trajectory export — schema v1 (direction #1 PR "A").
 *
 * Pure contract module. No runtime side effects, no chain I/O, no CLI
 * surface. Exporter, CLI command, turnId propagation, HF-dataset format,
 * and consent backfill are separate follow-up PRs (B–E).
 *
 * Design grounded in docs/dev/TRAJECTORY-EXPORT-V1.md and the concrete
 * `NapiBlock` shape from src/infra/storage/chain-file-io.ts:24.
 *
 * Five open questions from the design proposal are resolved with
 * defaults documented inline below. Reviewer can flag any to change
 * before merge — changes are small, localized.
 */

import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;

// ── Enums ────────────────────────────────────────────────────────────

/**
 * Nine event kinds cover every currently-observable turn artifact:
 * user input, prompt fragments the runtime assembled, tool calls and
 * their results, the assistant response, the cognitive prelude and
 * post-pass from `src/gateway/cognitive-runtime.ts`, durable chain
 * writes, and system events from boot / health / scheduler loops.
 */
export const TrajectoryEventKind = z.enum([
  'user_input',
  'prompt_fragment',
  'tool_call',
  'tool_result',
  'model_response',
  'cognitive_prelude',
  'cognitive_post',
  'chain_write',
  'system_event',
]);

/**
 * DEFAULT: three-level consent (see TRAJECTORY-EXPORT-V1.md Q#4). The
 * anonymized level is honored by the exporter by hashing the content
 * field; smart PII scrubbing is explicitly v2.
 */
export const ConsentLevel = z.enum(['exportable', 'local-only', 'anonymized']);

/**
 * Surface classification. `scheduler` covers cron-driven writes that
 * have no user-facing session; `system` covers boot / health / runtime
 * events that live on the `system` chain. DEFAULT Q#3: system events
 * are included in trajectory output marked with surface='system' so
 * consumers can filter, instead of split into a separate stream.
 */
export const TrajectorySurface = z.enum([
  'cli',
  'http',
  'mcp',
  'telegram',
  'scheduler',
  'system',
]);

// ── Provenance ───────────────────────────────────────────────────────

/**
 * Provenance is direct 1:1 mapping from `NapiBlock` fields in
 * src/infra/storage/chain-file-io.ts. No recomputation — the exporter
 * copies these straight off the read block. For in-memory events with
 * no backing chain block (frame-buffer snapshots, prompt-building
 * fragments), provenance is null.
 *
 * DEFAULT Q#4: blockHash uses SHA-256 of raw content, consistent with
 * `crates/memphis-core/src/block.rs` canonical hashing. No alternate
 * digest algorithms in v1.
 */
export const Provenance = z.object({
  chain: z.string().min(1),
  blockIndex: z.number().int().nonnegative(),
  blockHash: z.string().min(1), // hex-encoded SHA-256
  prevHash: z.string().min(1),
  signer: z.string().optional(), // hex-encoded Ed25519 pubkey
  signature: z.string().optional(), // hex-encoded Ed25519 signature
});

// ── Event ────────────────────────────────────────────────────────────

/**
 * A single event in a trajectory. Every event carries its kind, a
 * timestamp, the session binding (null for unbound events), the
 * surface it originated from, the consent level that gates its
 * export, optional provenance (null for in-memory), and a kind-
 * specific payload. Payload shapes per kind are documented in
 * TRAJECTORY-EXPORT-V1.md §Schema v1; runtime validation keeps the
 * payload as a record and defers per-kind typing to v1.1+.
 */
export const TrajectoryEvent = z.object({
  kind: TrajectoryEventKind,
  ts: z.string().datetime({ offset: true }),
  turnId: z.string().nullable(),
  surface: TrajectorySurface,
  consent: ConsentLevel,
  provenance: Provenance.nullable(),
  payload: z.record(z.string(), z.unknown()),
});

// ── Agent identity ───────────────────────────────────────────────────

/**
 * Agent identity snapshot at trajectory start. DEFAULT Q#2:
 * `instanceId` is the hex-encoded Ed25519 pubkey from the soul
 * manifest — more stable than a manifest-hash that rotates with
 * unrelated manifest edits.
 */
export const AgentIdentity = z.object({
  agentName: z.string().min(1),
  ownerName: z.string().min(1),
  instanceId: z.string().min(1),
});

// ── Integrity snapshot ───────────────────────────────────────────────

/**
 * Tail hashes per chain at export time. Consumers can verify their
 * copy of the trajectory against the producing runtime's chain state
 * without re-reading the whole chain. `eventCount` and
 * `signedEventCount` are convenience counters for dataset filters.
 */
export const TrajectoryIntegrity = z.object({
  chainHashes: z.record(z.string(), z.string()),
  eventCount: z.number().int().nonnegative(),
  signedEventCount: z.number().int().nonnegative(),
});

// ── Trajectory ───────────────────────────────────────────────────────

/**
 * A complete trajectory = one session's ordered story. DEFAULT Q#1:
 * `trajectoryId` is a per-session UUID stable across reboots —
 * replay (direction #2) needs stable identity for replayable ground
 * truth. `sessionId` is null when the events are scheduler-driven or
 * otherwise unbound to an operator session.
 */
export const Trajectory = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  trajectoryId: z.string().uuid(),
  sessionId: z.string().nullable(),
  agentIdentity: AgentIdentity,
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  turns: z.number().int().nonnegative(),
  events: z.array(TrajectoryEvent),
  integrity: TrajectoryIntegrity,
});

// ── Inferred TypeScript types ────────────────────────────────────────

export type TrajectoryEventKindT = z.infer<typeof TrajectoryEventKind>;
export type ConsentLevelT = z.infer<typeof ConsentLevel>;
export type TrajectorySurfaceT = z.infer<typeof TrajectorySurface>;
export type ProvenanceT = z.infer<typeof Provenance>;
export type TrajectoryEventT = z.infer<typeof TrajectoryEvent>;
export type AgentIdentityT = z.infer<typeof AgentIdentity>;
export type TrajectoryIntegrityT = z.infer<typeof TrajectoryIntegrity>;
export type TrajectoryT = z.infer<typeof Trajectory>;

// ── JSON Schema export (DEFAULT Q#5) ─────────────────────────────────

/**
 * Emits the Trajectory schema as a JSON Schema document so external
 * consumers (HuggingFace datasets, future RL tooling, third-party
 * validators) can validate trajectories without pulling the `zod`
 * runtime. Shipped in `dist/` via the existing `tsc` build — adds
 * no extra build-step.
 */
export function toJsonSchema(): Record<string, unknown> {
  // Zod 4 ships a native JSON-Schema emitter — no external dependency
  // required. External validators and dataset loaders (HuggingFace
  // datasets, RL tooling) consume this directly.
  return z.toJSONSchema(Trajectory) as Record<string, unknown>;
}
