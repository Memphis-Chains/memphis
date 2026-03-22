import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { MANIFEST_SCHEMA_VERSION, soulManifestSchema, type SoulManifest } from './types.js';
import { getConfigPath } from '../config/paths.js';
import { resolveAgentProfile } from '../infra/agent-profile.js';
import { getChainAdapterStatus } from '../infra/storage/chain-adapter.js';

// Static list of currently registered MCP tools.
// TODO: Switch to unified tool registry when available (Phase B).
const KNOWN_TOOLS = [
  'memphis_journal',
  'memphis_recall',
  'memphis_decide',
  'memphis_health',
  'memphis_web_fetch',
  'memphis_loop_step',
  'memphis_exec',
  'memphis_case_append',
  'memphis_case_query',
  'memphis_soul_read',
  'memphis_soul_write',
];

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
      tools: [...KNOWN_TOOLS],
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

  writeSoulManifest(fresh, rawEnv);
  return fresh;
}
