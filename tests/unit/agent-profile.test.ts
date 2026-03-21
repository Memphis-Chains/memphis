import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_NAME,
  DEFAULT_OWNER_NAME,
  getAgentProfilePath,
  resolveAgentProfile,
  writeAgentProfile,
} from '../../src/infra/agent-profile.js';
import { writeProfileEnv } from '../../src/infra/cli/onboarding-wizard.js';

const tempDirs: string[] = [];

function tempEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'memphis-profile-'));
  tempDirs.push(dir);
  return { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('agent profile', () => {
  it('falls back to env identity when no profile exists', () => {
    const env = {
      ...tempEnv(),
      MEMPHIS_AGENT_NAME: 'Jawor',
      MEMPHIS_OWNER_NAME: 'Marcin',
    } as NodeJS.ProcessEnv;

    const resolved = resolveAgentProfile(env);

    expect(resolved.source).toBe('env');
    expect(resolved.profile.agentName).toBe('Jawor');
    expect(resolved.profile.ownerName).toBe('Marcin');
  });

  it('prefers persisted profile over env values', () => {
    const env = {
      ...tempEnv(),
      MEMPHIS_AGENT_NAME: 'Env Agent',
      MEMPHIS_OWNER_NAME: 'Env Owner',
    } as NodeJS.ProcessEnv;

    const written = writeAgentProfile({ agentName: 'Profile Agent', ownerName: 'Profile Owner' }, env);
    const resolved = resolveAgentProfile(env);

    expect(written.path).toBe(getAgentProfilePath(env));
    expect(resolved.source).toBe('profile');
    expect(resolved.profile.agentName).toBe('Profile Agent');
    expect(resolved.profile.ownerName).toBe('Profile Owner');
  });

  it('writes neutral defaults when onboarding env is generated without explicit identity', () => {
    const env = tempEnv();
    const envPath = path.join(env.MEMPHIS_DATA_DIR as string, '.env');

    const result = writeProfileEnv(
      'dev-local',
      envPath,
      true,
      { apiToken: 'token', vaultPepper: 'memphis-super-secure-pepper' },
      undefined,
      env,
    );
    const resolved = resolveAgentProfile(env);

    expect(result.agentProfilePath).toBe(getAgentProfilePath(env));
    expect(result.secretAwareness.envPath).toBe(envPath);
    expect(result.secretAwareness.secrets.map((secret) => secret.key)).toEqual([
      'MEMPHIS_API_TOKEN',
      'MEMPHIS_VAULT_PEPPER',
    ]);
    expect(resolved.source).toBe('profile');
    expect(resolved.profile.agentName).toBe(DEFAULT_AGENT_NAME);
    expect(resolved.profile.ownerName).toBe(DEFAULT_OWNER_NAME);
  });
});
