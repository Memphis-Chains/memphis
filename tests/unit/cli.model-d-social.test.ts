import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI model D social commands', () => {
  it('supports agents/relationships/trust commands', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'memphis-cwd-'));
    const social = join(home, '.memphis', 'social');
    const syncAgentsPath = join(cwd, 'data', 'sync-agents.json');
    mkdirSync(social, { recursive: true });
    mkdirSync(join(cwd, 'data'), { recursive: true });

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

    writeFileSync(
      syncAgentsPath,
      JSON.stringify({
        agents: [
          {
            did: 'did:memphis:xyz',
            name: 'XYZ',
            endpoint: 'ws://127.0.0.1:8787',
            capabilities: ['sync.push'],
            status: 'online',
            lastSeen: new Date().toISOString(),
          },
        ],
        updatedAt: new Date().toISOString(),
      }),
    );

    const env = { HOME: home, DEFAULT_PROVIDER: 'local-fallback' };

    const agents = JSON.parse(await runCli(['agents', 'list', '--json'], { env, cwd }));
    expect(agents.count).toBe(1);

    const show = JSON.parse(
      await runCli(['agents', 'show', 'did:memphis:xyz', '--json'], { env, cwd }),
    );
    expect(show.agent.did).toBe('did:memphis:xyz');

    const rel = JSON.parse(
      await runCli(['relationships', 'show', 'did:memphis:xyz', '--json'], { env, cwd }),
    );
    expect(rel.count).toBe(1);

    const trust = JSON.parse(await runCli(['trust', 'did:memphis:xyz', '--json'], { env, cwd }));
    expect(trust.score).toBeGreaterThan(0);
  }, 15000);
});
