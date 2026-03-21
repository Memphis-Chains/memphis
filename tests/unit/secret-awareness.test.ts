import { describe, expect, it } from 'vitest';

import {
  buildSecretAwareness,
  renderSecretAwarenessText,
} from '../../src/infra/secret-awareness.js';

describe('secret awareness', () => {
  it('describes api token and vault pepper with operator context', () => {
    const awareness = buildSecretAwareness({
      envPath: '/tmp/.env',
      agentProfilePath: '/tmp/.memphis/config/agent-profile.json',
      apiToken: 'token-1234567890',
      vaultPepper: 'memphis-abcdef1234567890',
    });

    expect(awareness.secrets.map((secret) => secret.key)).toEqual([
      'MEMPHIS_API_TOKEN',
      'MEMPHIS_VAULT_PEPPER',
    ]);
    expect(renderSecretAwarenessText(awareness)).toContain('Protects authenticated HTTP routes');
    expect(renderSecretAwarenessText(awareness)).toContain('breaks access to previously encrypted vault data');
  });
});
