import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { MANIFEST_SCHEMA_VERSION, soulManifestSchema, type SoulManifest } from './types.js';
import { getConfigPath } from '../config/paths.js';
import { getToolNames } from '../gateway/tool-registry.js';
import { resolveAgentProfile } from '../infra/agent-profile.js';
import { getChainAdapterStatus } from '../infra/storage/chain-adapter.js';

const KNOWN_CHAINS = ['journal', 'decisions', 'system', 'reflections', 'cases'];
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
      tools: getToolNames(),
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
    trustRules: [],
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
  if (existing?.trustRules && existing.trustRules.length > 0) {
    fresh.trustRules = existing.trustRules;
  }

  writeSoulManifest(fresh, rawEnv);
  return fresh;
}
