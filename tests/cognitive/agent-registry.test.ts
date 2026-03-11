import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentRegistry } from '../../src/cognitive/agent-registry.js';

describe('AgentRegistry', () => {
  it('registers and retrieves an agent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-agent-registry-'));
    const registry = new AgentRegistry(join(dir, 'agents.json'));

    registry.register({
      did: 'did:memphis:a',
      name: 'A',
      publicKey: 'pk-a',
      capabilities: ['code'],
      reputation: 70,
      lastSeen: new Date(),
    });

    const agent = registry.getAgent('did:memphis:a');
    expect(agent?.name).toBe('A');
    expect(agent?.reputation).toBe(70);
  });

  it('updates reputation and lists active agents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-agent-registry-'));
    const registry = new AgentRegistry(join(dir, 'agents.json'));

    registry.register({
      did: 'did:memphis:b',
      name: 'B',
      publicKey: 'pk-b',
      capabilities: ['review'],
      reputation: 10,
      lastSeen: new Date(),
    });

    registry.updateReputation('did:memphis:b', 25);
    const updated = registry.getAgent('did:memphis:b');
    expect(updated?.reputation).toBe(35);

    const active = registry.listActive(60_000);
    expect(active).toHaveLength(1);
  });
});
