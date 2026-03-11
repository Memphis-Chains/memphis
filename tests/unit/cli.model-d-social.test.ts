import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CLI model D social commands', () => {
  it('supports agents/relationships/trust commands', () => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-home-'));
    const social = join(home, '.memphis', 'social');
    mkdirSync(social, { recursive: true });

    writeFileSync(
      join(social, 'agents.json'),
      JSON.stringify([
        {
          did: 'did:memphis:xyz',
          name: 'XYZ',
          publicKey: 'pk',
          capabilities: ['code'],
          reputation: 80,
          lastSeen: new Date().toISOString(),
        },
      ]),
    );

    writeFileSync(
      join(social, 'relationships.json'),
      JSON.stringify([
        {
          from: 'did:memphis:xyz',
          to: 'did:memphis:abc',
          type: 'trusts',
          strength: 0.8,
          interactions: 3,
          lastInteraction: new Date().toISOString(),
        },
      ]),
    );

    writeFileSync(
      join(social, 'trust-metrics.json'),
      JSON.stringify([
        {
          from: 'did:memphis:abc',
          to: 'did:memphis:xyz',
          score: 0.9,
          interactions: 5,
          lastUpdated: new Date().toISOString(),
        },
      ]),
    );

    const env = { ...process.env, HOME: home, DEFAULT_PROVIDER: 'local-fallback' };

    const agents = JSON.parse(execSync('npx tsx src/infra/cli/index.ts agents list --json', { encoding: 'utf8', env }));
    expect(agents.count).toBe(1);

    const show = JSON.parse(execSync('npx tsx src/infra/cli/index.ts agents show did:memphis:xyz --json', { encoding: 'utf8', env }));
    expect(show.agent.did).toBe('did:memphis:xyz');

    const rel = JSON.parse(execSync('npx tsx src/infra/cli/index.ts relationships show did:memphis:xyz --json', { encoding: 'utf8', env }));
    expect(rel.count).toBe(1);

    const trust = JSON.parse(execSync('npx tsx src/infra/cli/index.ts trust did:memphis:xyz --json', { encoding: 'utf8', env }));
    expect(trust.score).toBeGreaterThan(0);
  });
});
