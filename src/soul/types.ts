import { z } from 'zod';

// ── Schema Versions ──────────────────────────────────────────────────────────

export const MANIFEST_SCHEMA_VERSION = 1;
export const MEMORY_SCHEMA_VERSION = 1;

// ── Soul Manifest ────────────────────────────────────────────────────────────

export interface SoulIdentity {
  agentName: string;
  ownerName: string;
  did?: string;
  runtimeMode: string;
  createdAt: string;
}

export interface SoulCapabilities {
  tools: string[];
  chains: string[];
  channels: string[];
  providers: string[];
  rustBridge: boolean;
}

export interface SoulBoundaryTier {
  auth: string;
  scope: string;
}

export interface SoulBoundaries {
  tier0: SoulBoundaryTier;
  tier1: SoulBoundaryTier;
  tier2: SoulBoundaryTier;
}

export interface SoulEvolutionPolicy {
  autoApproveReflections: boolean;
  requirePassphraseForTier2: boolean;
  passphraseHash?: string;
  snapshotBeforeEvolution: boolean;
}

// ── Autonomy Mode & Trust Rules ─────────────────────────────────────────────

export type AutonomyMode = 'full' | 'quiet' | 'balanced' | 'paranoid';

/** Cognitive engine operating mode (A-E), distinct from autonomy mode. */
export type CognitiveMode = 'A' | 'B' | 'C' | 'D' | 'E';

export interface TrustRule {
  tool: string;
  autoApprove: boolean;
  condition?: Record<string, unknown>;
  addedAt: string;
}

export interface SoulManifest {
  schemaVersion: number;
  generatedAt: string;
  identity: SoulIdentity;
  capabilities: SoulCapabilities;
  boundaries: SoulBoundaries;
  evolution: SoulEvolutionPolicy;
  mode: AutonomyMode;
  cognitiveMode?: CognitiveMode;
  cognitiveModeUpdatedAt?: string;
  trustRules: TrustRule[];
}

// ── Soul Memory ──────────────────────────────────────────────────────────────

export interface SoulMemoryUser {
  name?: string;
  languages: string[];
  preferences: string[];
  expertise: string[];
  integrations: string[];
}

export interface SoulMemorySelf {
  personality?: string;
  strengths: string[];
  learnings: string[];
  evolvedCapabilities: string[];
}

export interface SoulMemoryContext {
  activeWork?: string;
  recentDecisions: string[];
}

export interface SoulMemory {
  schemaVersion: number;
  lastUpdated: string;
  user: SoulMemoryUser;
  self: SoulMemorySelf;
  context: SoulMemoryContext;
}

// ── Soul Memory Update (deep partial for merge writes) ───────────────────────

export interface SoulMemoryUpdate {
  user?: Partial<SoulMemoryUser>;
  self?: Partial<SoulMemorySelf>;
  context?: Partial<SoulMemoryContext>;
}

// ── Zod Schemas ──────────────────────────────────────────────────────────────

export const soulBoundaryTierSchema = z.object({
  auth: z.string().min(1),
  scope: z.string().min(1),
});

export const autonomyModeSchema = z.enum(['full', 'quiet', 'balanced', 'paranoid']);

export const trustRuleSchema = z.object({
  tool: z.string().min(1),
  autoApprove: z.boolean(),
  condition: z.record(z.string(), z.unknown()).optional(),
  addedAt: z.string().min(1),
});

export const soulManifestSchema = z.object({
  schemaVersion: z.number().int().min(1),
  generatedAt: z.string().min(1),
  identity: z.object({
    agentName: z.string().trim().min(1),
    ownerName: z.string().trim().min(1),
    did: z.string().optional(),
    runtimeMode: z.string().min(1),
    createdAt: z.string().min(1),
  }),
  capabilities: z.object({
    tools: z.array(z.string()),
    chains: z.array(z.string()),
    channels: z.array(z.string()),
    providers: z.array(z.string()),
    rustBridge: z.boolean(),
  }),
  boundaries: z.object({
    tier0: soulBoundaryTierSchema,
    tier1: soulBoundaryTierSchema,
    tier2: soulBoundaryTierSchema,
  }),
  evolution: z.object({
    autoApproveReflections: z.boolean(),
    requirePassphraseForTier2: z.boolean(),
    passphraseHash: z.string().optional(),
    snapshotBeforeEvolution: z.boolean(),
  }),
  mode: autonomyModeSchema.default('balanced'),
  cognitiveMode: z.enum(['A', 'B', 'C', 'D', 'E']).optional(),
  cognitiveModeUpdatedAt: z.string().optional(),
  trustRules: z.array(trustRuleSchema).default([]),
});

export const soulMemoryUserSchema = z.object({
  name: z.string().optional(),
  languages: z.array(z.string()).default([]),
  preferences: z.array(z.string()).default([]),
  expertise: z.array(z.string()).default([]),
  integrations: z.array(z.string()).default([]),
});

export const soulMemorySelfSchema = z.object({
  personality: z.string().optional(),
  strengths: z.array(z.string()).default([]),
  learnings: z.array(z.string()).default([]),
  evolvedCapabilities: z.array(z.string()).default([]),
});

export const soulMemoryContextSchema = z.object({
  activeWork: z.string().optional(),
  recentDecisions: z.array(z.string()).default([]),
});

export const soulMemorySchema = z.object({
  schemaVersion: z.number().int().min(1),
  lastUpdated: z.string().min(1),
  user: soulMemoryUserSchema,
  self: soulMemorySelfSchema,
  context: soulMemoryContextSchema,
});

// ── ISKRA (Soul Identity Prompt) ─────────────────────────────────────────────

export interface IskraPrompt {
  identity: string;
  tools: string;
  rules: string;
  adaptation: string;
}

// ── PULSE (Heartbeat/Liveness) ──────────────────────────────────────────────

export type PulseEventType =
  | 'boot'
  | 'heartbeat'
  | 'identity-assert'
  | 'adaptation'
  | 'mode-change';

export interface PulseEntry {
  timestamp: string;
  event: PulseEventType;
  health: 'healthy' | 'degraded' | 'unhealthy';
  uptimeSeconds: number;
  cognitiveMode?: string;
  detail?: string;
  activeSurfaces?: string[];
}

// ── Interaction Memory (Burn-After-Action) ──────────────────────────────────

export type MemoryActionType = 'decision' | 'context' | 'insight' | 'learning' | 'adaptation';

export interface MemoryActionEntry {
  id: string;
  timestamp: string;
  actionType: MemoryActionType;
  summary: string;
  burned: boolean;
  burnedAt?: string;
}

export interface InteractionSummary {
  timestamp: string;
  inputSummary: string;
  decisions: string[];
  insights: string[];
  followUps: string[];
}

export const interactionSummarySchema = z.object({
  timestamp: z.string().min(1),
  inputSummary: z.string().min(1),
  decisions: z.array(z.string()).default([]),
  insights: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
});

// Codex Round 1 (2026-05-08) #525: Zod object types strip unknown keys
// silently by default; without `.strict()` a payload like
// `{ context: { weirdKey: "x" } }` parses successfully into
// `{ context: {} }` and runMemphisSoulWrite reports a successful
// context update while no requested field persists. Strict each
// nested object so unknown keys throw at parse time and the caller
// surfaces a helpful error to the LLM instead of silently dropping
// the field. This is the same defence as the in-process tool-executor
// gate (PR #525) but at the schema level — both paths now reject
// instead of strip.
export const soulMemoryUpdateSchema = z
  .object({
    user: z
      .object({
        name: z.string().optional(),
        languages: z.array(z.string()).optional(),
        preferences: z.array(z.string()).optional(),
        expertise: z.array(z.string()).optional(),
        integrations: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    self: z
      .object({
        personality: z.string().optional(),
        strengths: z.array(z.string()).optional(),
        learnings: z.array(z.string()).optional(),
        evolvedCapabilities: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    context: z
      .object({
        activeWork: z.string().optional(),
        recentDecisions: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
