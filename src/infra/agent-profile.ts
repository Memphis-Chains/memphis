import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { getDataDir } from '../config/paths.js';

export const DEFAULT_AGENT_NAME = 'Memphis Agent';
export const DEFAULT_OWNER_NAME = 'local operator';

const agentProfileSchema = z.object({
  schemaVersion: z.literal(1),
  agentName: z.string().trim().min(1),
  ownerName: z.string().trim().min(1),
  runtimeMode: z.enum(['solo-local']).default('solo-local'),
  toolPolicy: z.enum(['operator-supervised']).default('operator-supervised'),
  behaviorRules: z.array(z.string().trim().min(1)).min(1),
});

export type AgentProfile = z.infer<typeof agentProfileSchema>;

export type ResolvedAgentProfile = {
  profile: AgentProfile;
  path: string;
  source: 'profile' | 'env' | 'default';
};

export function getAgentProfilePath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDataDir(rawEnv), 'config', 'agent-profile.json');
}

export function defaultAgentProfile(
  overrides: Partial<Pick<AgentProfile, 'agentName' | 'ownerName'>> = {},
): AgentProfile {
  return {
    schemaVersion: 1,
    agentName: overrides.agentName?.trim() || DEFAULT_AGENT_NAME,
    ownerName: overrides.ownerName?.trim() || DEFAULT_OWNER_NAME,
    runtimeMode: 'solo-local',
    toolPolicy: 'operator-supervised',
    behaviorRules: [
      'Operate locally and keep durable memory auditable.',
      'Use tools deliberately and prefer reversible actions.',
      'Treat vault-managed secrets as operator-controlled state.',
    ],
  };
}

export function loadAgentProfile(rawEnv: NodeJS.ProcessEnv = process.env): AgentProfile | null {
  const profilePath = getAgentProfilePath(rawEnv);
  if (!existsSync(profilePath)) return null;
  const raw = JSON.parse(readFileSync(profilePath, 'utf8')) as unknown;
  return agentProfileSchema.parse(raw);
}

export function resolveAgentProfile(rawEnv: NodeJS.ProcessEnv = process.env): ResolvedAgentProfile {
  const profilePath = getAgentProfilePath(rawEnv);

  try {
    const profile = loadAgentProfile(rawEnv);
    if (profile) {
      return { profile, path: profilePath, source: 'profile' };
    }
  } catch {
    // Invalid profile should not break the runtime; fall back to env/defaults.
  }

  const envAgentName = rawEnv.MEMPHIS_AGENT_NAME?.trim();
  const envOwnerName = rawEnv.MEMPHIS_OWNER_NAME?.trim();
  if (envAgentName || envOwnerName) {
    return {
      profile: defaultAgentProfile({
        agentName: envAgentName,
        ownerName: envOwnerName,
      }),
      path: profilePath,
      source: 'env',
    };
  }

  return {
    profile: defaultAgentProfile(),
    path: profilePath,
    source: 'default',
  };
}

export function writeAgentProfile(
  input: Partial<Pick<AgentProfile, 'agentName' | 'ownerName'>> = {},
  rawEnv: NodeJS.ProcessEnv = process.env,
): { path: string; profile: AgentProfile } {
  const existing = resolveAgentProfile(rawEnv).profile;
  const next = defaultAgentProfile({
    agentName: input.agentName?.trim() || existing.agentName,
    ownerName: input.ownerName?.trim() || existing.ownerName,
  });

  const profilePath = getAgentProfilePath(rawEnv);
  mkdirSync(path.dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  return { path: profilePath, profile: next };
}
