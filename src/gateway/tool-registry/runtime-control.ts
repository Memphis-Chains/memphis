import { z } from 'zod';

import type { ToolMeta } from '../tool-metadata.js';

export const RUNTIME_CONTROL_TOOLS: Record<string, ToolMeta> = {
  memphis_providers: {
    name: 'memphis_providers',
    tier: 0,
    capabilities: ['read'],
    description: 'Inspect configured providers, default models, and discovered model lists',
    featureFlag: 'experimental-tools',
    inputSchema: z
      .object({
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Snapshot of LLM provider configuration: which providers are wired (Ollama/Anthropic/OpenAI/GLM/...), which is the default per Ollama-first cascade, what model each provider has selected, and the discovered-model list per provider (where supported). Use to answer "which model are you actually using" or to debug "why is Ollama not the fallback" — the cascade picks Ollama first by design but each layer can be overridden via env. Gated behind `experimental-tools` because the introspection surface is intentionally diagnostic-only.',
    cliFlags: [],
  },
  memphis_system_info: {
    name: 'memphis_system_info',
    tier: 0,
    capabilities: ['read'],
    description: 'Inspect host and Memphis runtime system details',
    featureFlag: 'experimental-tools',
    inputSchema: z
      .object({
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Host + runtime fingerprint: OS / arch / Node version / Rust toolchain / NAPI binary triple / install root / data dir / Memphis version. Pure read-only. Operators use this to confirm "is Memphis running on the box I think it is" before committing to actions; LLM uses it to disambiguate platform-specific advice (e.g. apt vs brew, systemd vs launchd). No PII, no secrets — safe to render to any surface. Gated behind `experimental-tools` for parity with memphis_providers.',
    cliFlags: [],
  },
  memphis_presence: {
    name: 'memphis_presence',
    tier: 0,
    capabilities: ['read'],
    description: 'Cross-surface presence snapshot (TUI / Telegram / HTTP)',
    inputSchema: z
      .object({
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Returns when each surface (TUI / Telegram / HTTP / MCP) was last active — last message time, last tool call, current cognitive mode per surface. Sourced from `core/surface-presence.ts` (recordSurfaceActivity) which writes on every inbound event. Use to answer "is the operator on Telegram right now" or "did the TUI session disconnect". Pure read-only; no side effects.',
    cliFlags: [],
  },
  memphis_config_show: {
    name: 'memphis_config_show',
    tier: 0,
    capabilities: ['read'],
    description: 'Show current runtime config (redacted)',
    inputSchema: z
      .object({
        key: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Read the current runtime config — every key in the env schema with its mutability classification (mutable/cold/secret) and current value. Secret-classified fields are redacted; mutable + cold show plaintext. `key` narrows to one entry. Use to answer "what value is X right now" or to verify a config_set landed. Companion to memphis_config_set + memphis_config_reload.',
    cliFlags: [
      {
        name: '--key',
        description: 'Single config key to show (default: all).',
        takesValue: true,
      },
    ],
  },
  memphis_config_reload: {
    name: 'memphis_config_reload',
    tier: 2,
    capabilities: ['write'],
    description: 'Re-read .env and hot-swap mutable fields',
    inputSchema: z
      .object({
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Re-read `.env` and apply hot-swappable changes without restarting. Mutable fields (LOG_LEVEL, MEMPHIS_VOICE_MODE, provider keys, etc.) propagate to live loggers + caches via post-apply hooks. Cold fields (anything that affects boot wiring — DATABASE_URL, MEMPHIS_AGENT_NAME, RUST_CHAIN_BRIDGE_PATH) are listed in the response but NOT applied — those need memphis_restart. Use after editing `.env` or after memphis_config_set on a hot key.',
    cliFlags: [],
  },
  memphis_restart: {
    name: 'memphis_restart',
    tier: 2,
    capabilities: ['write'],
    description: 'Request a self-restart (tier-3 session required)',
    inputSchema: z
      .object({
        reason: z.string().optional(),
        actor_id: z.string().optional(),
        passphrase: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Restart the Memphis runtime in-place. Tier-2 + tier-3 session required (passphrase-gated) — operator-only by design, since restart drops in-flight conversations and resets cognitive context. The audit chain logs `reason` for forensics. Use after applying cold-field config changes (memphis_config_set on cold fields) or after memphis_self_modify to load the new code. Passphrase field is redacted in the persisted approval record.',
    cliFlags: [
      {
        name: '--reason',
        description: 'Operator-facing reason for the restart (audit trail).',
        takesValue: true,
      },
      {
        name: '--passphrase',
        description: 'Operator passphrase (required for tier-3 elevation).',
        takesValue: true,
      },
    ],
  },
  memphis_config_set: {
    name: 'memphis_config_set',
    tier: 2,
    capabilities: ['write'],
    description:
      'Set a single config key/value. Cold fields refuse; secret fields require operator passphrase.',
    inputSchema: z
      .object({
        key: z.string().min(1),
        value: z.string(),
        passphrase: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Update a single config key in `.env`, then trigger hot-reload for mutable fields. Three classifications (per `src/infra/config/mutability.ts`): `mutable` (apply immediately), `cold` (refuses with 409 — operator must edit `.env` + restart), `secret` (requires operator passphrase, redacted in audit). Vault-resolved fields (vault://...) get their plaintext stored encrypted — never logged. Use for one-shot tweaks; for bulk changes edit `.env` directly + run memphis_config_reload.',
    cliFlags: [
      {
        name: '--key',
        description: 'Config key. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--value',
        description: 'New value. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--passphrase',
        description: 'Operator passphrase (required for secret-classified keys).',
        takesValue: true,
      },
    ],
  },
  memphis_cognitive_mode_set: {
    name: 'memphis_cognitive_mode_set',
    tier: 2,
    capabilities: ['write'],
    description: 'Switch cognitive mode (A–E). Requires operator passphrase.',
    inputSchema: z
      .object({
        mode: z.enum(['A', 'B', 'C', 'D', 'E']),
        passphrase: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Switch the active cognitive mode. Modes: `A` (capture, default — temperature low, fast deterministic), `B` (inferred — Model B decision pattern recognition), `C` (predictive — Model C pattern projection), `D` (collective — multi-agent coordination), `E` (meta — weekly reflection synthesis). The mode change writes to soul-manifest, broadcasts on the system chain, and updates the heartbeat watchdog. Passphrase-gated to prevent surface-side mode flips. Operators usually change mode via `/mode A|B|C|D|E` in Telegram or `memphis trust mode set` in CLI; this MCP tool exists for programmatic flips.',
    cliFlags: [
      {
        name: '--mode',
        description: 'Target mode: A | B | C | D | E. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--passphrase',
        description: 'Operator passphrase. Required.',
        takesValue: true,
        required: true,
      },
    ],
  },
};
