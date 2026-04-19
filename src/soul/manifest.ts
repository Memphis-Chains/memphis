import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadSoulMemory } from './memory.js';
import {
  MANIFEST_SCHEMA_VERSION,
  autonomyModeSchema,
  soulManifestSchema,
  type AutonomyMode,
  type CognitiveMode,
  type IskraPrompt,
  type SoulManifest,
} from './types.js';
import { getConfigPath } from '../config/paths.js';
import { getToolNames } from '../gateway/tool-registry.js';
import { resolveAgentProfile } from '../infra/agent-profile.js';
import { getChainAdapterStatus } from '../infra/storage/chain-adapter.js';

const KNOWN_CHAINS = [
  'journal',
  'decisions',
  'system',
  'reflections',
  'cases',
  'collective',
  'patterns',
  'proactive',
];
const KNOWN_CHANNELS = ['cli', 'mcp', 'http'];

export function getSoulManifestPath(_rawEnv: NodeJS.ProcessEnv = process.env): string {
  return getConfigPath('soul-manifest.json');
}

export function generateSoulManifest(rawEnv: NodeJS.ProcessEnv = process.env): SoulManifest {
  const resolved = resolveAgentProfile(rawEnv);
  const chainStatus = getChainAdapterStatus(rawEnv);

  const providers: string[] = [];
  const defaultProvider = rawEnv.DEFAULT_PROVIDER ?? rawEnv.MEMPHIS_DEFAULT_PROVIDER;
  if (defaultProvider) providers.push(defaultProvider);
  const soulProvider = rawEnv.SOUL_PROVIDER;
  if (soulProvider && !providers.includes(soulProvider)) providers.push(soulProvider);

  const channels = [...KNOWN_CHANNELS];
  if (rawEnv.TELEGRAM_BOT_TOKEN) channels.push('telegram');

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    identity: {
      agentName: resolved.profile.agentName,
      ownerName: resolved.profile.ownerName,
      runtimeMode: resolved.profile.runtimeMode,
      createdAt: new Date().toISOString(),
    },
    capabilities: {
      tools: getToolNames(rawEnv),
      chains: [...KNOWN_CHAINS],
      channels,
      providers,
      rustBridge: chainStatus.rustBridgeLoaded,
    },
    boundaries: {
      tier0: { auth: 'none', scope: 'soul memory, journal, recall, health, case entries' },
      tier1: { auth: 'api_token', scope: 'config, channels, providers, vault secrets' },
      tier2: {
        auth: 'vault_passphrase',
        scope: 'source code, tools, handlers — requires snapshot + branch + tests',
      },
    },
    evolution: {
      autoApproveReflections: true,
      requirePassphraseForTier2: true,
      snapshotBeforeEvolution: true,
    },
    mode: 'balanced',
    trustRules: [
      // Tier 2 tools - auto-approved for operator convenience
      // These require passphrase via Tier 2 gate, trustRules just skip approval prompt
      { tool: 'memphis_exec', autoApprove: true, addedAt: new Date().toISOString() },
      { tool: 'memphis_self_modify', autoApprove: true, addedAt: new Date().toISOString() },
    ],
  };
}

export function loadSoulManifest(rawEnv: NodeJS.ProcessEnv = process.env): SoulManifest | null {
  const manifestPath = getSoulManifestPath(rawEnv);
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    return soulManifestSchema.parse(raw);
  } catch {
    return null;
  }
}

export function writeSoulManifest(
  manifest: SoulManifest,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  const manifestPath = getSoulManifestPath(rawEnv);
  const dir = path.dirname(manifestPath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
  renameSync(tmpPath, manifestPath);
}

export function ensureSoulManifest(rawEnv: NodeJS.ProcessEnv = process.env): SoulManifest {
  const existing = loadSoulManifest(rawEnv);
  const fresh = generateSoulManifest(rawEnv);

  // Preserve original createdAt if manifest already existed
  if (existing?.identity.createdAt) {
    fresh.identity.createdAt = existing.identity.createdAt;
  }

  // Preserve DID if set
  if (existing?.identity.did) {
    fresh.identity.did = existing.identity.did;
  }

  // Preserve autonomy mode and trust rules
  if (existing?.mode) {
    fresh.mode = existing.mode;
  }
  // Env var override takes highest priority
  const envMode = rawEnv.MEMPHIS_AUTONOMY_MODE;
  if (envMode) {
    const parsed = autonomyModeSchema.safeParse(envMode);
    if (parsed.success) {
      fresh.mode = parsed.data as AutonomyMode;
    }
  }
  if (existing?.trustRules && existing.trustRules.length > 0) {
    fresh.trustRules = existing.trustRules;
  }
  // Preserve cognitive mode
  if (existing?.cognitiveMode) {
    fresh.cognitiveMode = existing.cognitiveMode;
  }
  if (existing?.cognitiveModeUpdatedAt) {
    fresh.cognitiveModeUpdatedAt = existing.cognitiveModeUpdatedAt;
  }

  // Preserve evolution settings including passphraseHash (Tier 2 auth)
  if (existing?.evolution) {
    fresh.evolution = { ...fresh.evolution, ...existing.evolution };
  }

  writeSoulManifest(fresh, rawEnv);
  return fresh;
}

export function getCognitiveMode(rawEnv: NodeJS.ProcessEnv = process.env): CognitiveMode {
  const manifest = loadSoulManifest(rawEnv);
  return manifest?.cognitiveMode ?? 'A';
}

export function getCognitiveModeLastModified(
  rawEnv: NodeJS.ProcessEnv = process.env,
): string | null {
  const manifest = loadSoulManifest(rawEnv);
  return manifest?.cognitiveModeUpdatedAt ?? null;
}

export function setCognitiveMode(
  mode: CognitiveMode,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  const manifest = loadSoulManifest(rawEnv);
  if (!manifest) return;

  const previousMode = manifest.cognitiveMode ?? 'A';
  manifest.cognitiveMode = mode;
  manifest.cognitiveModeUpdatedAt = new Date().toISOString();
  writeSoulManifest(manifest, rawEnv);

  // Write mode change to system chain and PULSE (non-blocking, non-fatal)
  if (previousMode !== mode) {
    void import('../infra/storage/chain-adapter.js')
      .then(({ appendBlock }) =>
        appendBlock('system', {
          type: 'mode_change',
          source: 'soul-manifest',
          schemaVersion: 1,
          content: `Cognitive mode changed: ${previousMode} → ${mode}`,
          tags: ['system', 'mode-change', `mode-${mode.toLowerCase()}`],
          previousMode,
          newMode: mode,
        }),
      )
      .catch(() => undefined);
    void import('../infra/runtime/heartbeat-watchdog.js')
      .then(({ writePulseEvent }) =>
        writePulseEvent({
          timestamp: new Date().toISOString(),
          event: 'mode-change',
          health: 'healthy',
          uptimeSeconds: Math.floor(process.uptime()),
          cognitiveMode: mode,
          detail: `${previousMode} → ${mode}`,
        }),
      )
      .catch(() => undefined);
  }
}

// ── ISKRA (Soul Identity Prompt) ────────────────────────────────────────────

export function getIskraPath(_rawEnv: NodeJS.ProcessEnv = process.env): string {
  return getConfigPath('ISKRA.md');
}

export function buildIskraPrompt(
  manifest: SoulManifest,
  rawEnv: NodeJS.ProcessEnv = process.env,
): IskraPrompt {
  const memory = loadSoulMemory(rawEnv);
  const { identity, capabilities, boundaries } = manifest;

  const identitySection = [
    `I am ${identity.agentName}, owned by ${identity.ownerName}.`,
    `Runtime: ${identity.runtimeMode}. Mode: ${manifest.mode}.`,
    identity.did ? `DID: ${identity.did}` : '',
    memory?.self?.personality ? `Personality: ${memory.self.personality}` : '',
    memory?.user?.languages?.length ? `Languages: ${memory.user.languages.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const toolsSection = capabilities.tools.map((t) => `- ${t}`).join('\n');

  const rulesSection = [
    `- Tier 0 (${boundaries.tier0.auth}): ${boundaries.tier0.scope}`,
    `- Tier 1 (${boundaries.tier1.auth}): ${boundaries.tier1.scope}`,
    `- Tier 2 (${boundaries.tier2.auth}): ${boundaries.tier2.scope}`,
    `- Chains: ${capabilities.chains.join(', ')}`,
    `- Channels: ${capabilities.channels.join(', ')}`,
    capabilities.rustBridge ? '- Rust bridge: active' : '- Rust bridge: inactive (TS fallback)',
  ].join('\n');

  const adaptationParts: string[] = [];
  if (memory?.self?.learnings?.length) {
    adaptationParts.push('Learnings:');
    for (const l of memory.self.learnings.slice(0, 10)) {
      adaptationParts.push(`- ${l}`);
    }
  }
  if (memory?.self?.strengths?.length) {
    adaptationParts.push('Strengths:');
    for (const s of memory.self.strengths.slice(0, 5)) {
      adaptationParts.push(`- ${s}`);
    }
  }
  if (memory?.user?.preferences?.length) {
    adaptationParts.push('User preferences:');
    for (const p of memory.user.preferences.slice(0, 5)) {
      adaptationParts.push(`- ${p}`);
    }
  }
  if (memory?.user?.expertise?.length) {
    adaptationParts.push(`User expertise: ${memory.user.expertise.join(', ')}`);
  }

  return {
    identity: identitySection,
    tools: toolsSection,
    rules: rulesSection,
    adaptation: adaptationParts.join('\n') || 'No adaptation data yet.',
  };
}

export function renderIskraMarkdown(prompt: IskraPrompt, agentName: string): string {
  return `# ISKRA — ${agentName}

## Identity
${prompt.identity}

## Tools
${prompt.tools}

## Rules
${prompt.rules}

## Adaptation
${prompt.adaptation}
`;
}

export function writeIskra(content: string, rawEnv: NodeJS.ProcessEnv = process.env): void {
  const iskraPath = getIskraPath(rawEnv);
  const dir = path.dirname(iskraPath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = `${iskraPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, iskraPath);
}

export function loadIskra(rawEnv: NodeJS.ProcessEnv = process.env): string | null {
  const iskraPath = getIskraPath(rawEnv);
  if (!existsSync(iskraPath)) return null;
  try {
    const content = readFileSync(iskraPath, 'utf8');
    return content.trim().length > 0 ? content : null;
  } catch {
    return null;
  }
}

export function ensureIskra(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const manifest = loadSoulManifest(rawEnv);
  if (!manifest) {
    return loadIskra(rawEnv) ?? '';
  }

  const prompt = buildIskraPrompt(manifest, rawEnv);
  const content = renderIskraMarkdown(prompt, manifest.identity.agentName);
  writeIskra(content, rawEnv);
  return content;
}
