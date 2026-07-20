import { z } from 'zod';

import type { ToolMeta } from '../tool-metadata.js';

export const RUNTIME_HEALTH_TOOLS: Record<string, ToolMeta> = {
  memphis_health: {
    name: 'memphis_health',
    tier: 0,
    capabilities: ['read'],
    description: 'Check runtime health',
    inputSchema: z
      .object({
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Compact health snapshot: runtime uptime, provider readiness, vault cipher probe, chain integrity, embed pipeline status, recent telemetry. Counterpart to `memphis doctor` but JSON-shaped and faster — use this for programmatic gating, doctor for human triage.',
    cliFlags: [],
  },
  memphis_self_describe: {
    name: 'memphis_self_describe',
    tier: 0,
    capabilities: ['read'],
    description:
      'Runtime self-introspection — returns active surface policy, effective tier (with tier-3 session info), cognitive mode, full tool inventory with availability, feature flags, and cross-surface tier-3 sessions. Use this BEFORE answering "what can you do" — never hallucinate capabilities from training data.',
    inputSchema: z
      .object({
        surface: z.string().optional(),
        actorId: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Compact runtime introspection. Surfaces the LIVE picture: active surface (mcp/cli/telegram/tui/http), effective tool tier (after surface policy + tier-3 elevation), cognitive mode (A-E), the full registered-tool list with each tool\'s availability under the current policy, active feature flags, and cross-surface tier-3 sessions. Operator capability questions ("what can you do", "co potrafisz", "show capabilities") MUST call this first — bot training data is months out of date and will confabulate. Output is JSON-shaped, safe to render to the operator verbatim.',
    cliFlags: [
      {
        name: '--surface',
        description:
          'Override the surface name used for policy resolution (default: caller\'s surface).',
        takesValue: true,
      },
      {
        name: '--actor-id',
        description:
          'Actor id used for tier-3 session lookup on the resolved surface (default: "local").',
        takesValue: true,
      },
    ],
  },
  memphis_slo_status: {
    name: 'memphis_slo_status',
    tier: 0,
    capabilities: ['read'],
    description:
      'Runtime SLO snapshot — reads telemetry spans over a time window (default 7 days) and reports each SLO as pass/fail/unavailable with computed value, threshold, and sample count. Use to answer "is the runtime healthy" or to gate alerts.',
    inputSchema: z
      .object({
        windowDays: z.number().int().min(1).max(90).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Reads telemetry spans (sourced from `~/.memphis/telemetry/`) over a rolling window and evaluates the implemented SLOs: p99 turn latency, confabulation rate, provider error rate, and tool error rate. Each SLO returns `pass | fail | unavailable` with computed value, threshold, and sample count so the operator can see WHY the runtime is degraded, not just THAT it is. `unavailable` means the SLO has no samples or fewer than the minimum sample floor in the window — usually fine for a fresh install, but a logging gap on a long-running runtime.',
    cliFlags: [
      {
        name: '--window-days',
        description: 'Rolling window in days (1-90, default 7).',
        takesValue: true,
      },
    ],
  },
  memphis_self_governance_status: {
    name: 'memphis_self_governance_status',
    tier: 0,
    capabilities: ['read'],
    description:
      'Read Memphis self-governance capability state — supervised-operational autonomy readiness, recovery blockers, and required operator actions.',
    inputSchema: z
      .object({
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Canonical answer for "can Memphis steer itself and preserve that ability?". Aggregates runtime health, chain integrity, backup readiness, provider/fallback readiness, scheduler posture, and SLO state into `capable`, `canSelfRecover`, `canSelfModify=false`, `blockingReasons`, and `recommendedActions`. Read-only; it never restarts, repairs, deploys, or edits code.',
    cliFlags: [],
  },
  memphis_tensor_status: {
    name: 'memphis_tensor_status',
    tier: 0,
    capabilities: ['read'],
    description:
      'Read Memphis tensor/vector runtime truth — memory embedding dim/provider/persistence, Kartograf tensor mode, and public raw-vector exposure policy.',
    inputSchema: z
      .object({
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Use this to answer "what do tensors look like in Memphis right now?". Reports Rust memory embeddings (`Vec<f32>`), Kartograf embeddings (`Float32Array`/ONNX), configured dimensions, dtype, persistence, bridge readiness, and whether a legacy index dim mismatch is present. It never returns raw vector values.',
    cliFlags: [],
  },
  memphis_repair: {
    name: 'memphis_repair',
    tier: 0,
    capabilities: ['write'],
    description:
      'Repair Memphis runtime state — chain integrity, SQLite, migrations, derived indexes',
    inputSchema: z
      .object({
        force: z.boolean().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Idempotent repair sweep over runtime state: chain integrity (rebuild missing index entries, drop orphans), SQLite migrations (apply any pending), derived indexes (case-index, embed-index reseed when stale). Safe to call from a healthy runtime — it is a no-op when nothing needs repair. Use after a crash, partial restore, or before the operator runs an export to be sure on-disk state is consistent.',
    cliFlags: [],
  }
};
