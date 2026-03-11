import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { TrustMetrics } from '../../src/cognitive/trust-metrics.js';

describe('TrustMetrics', () => {
  it('records interactions and calculates local/global trust', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-trust-'));
    const trust = new TrustMetrics(join(dir, 'trust-metrics.json'));

    trust.recordInteraction('did:memphis:a', 'did:memphis:b', 'positive');
    trust.recordInteraction('did:memphis:c', 'did:memphis:b', 'negative');

    expect(trust.calculateLocalTrust('did:memphis:a', 'did:memphis:b')).toBeGreaterThan(0.5);
    expect(trust.calculateGlobalTrust('did:memphis:b')).toBeGreaterThan(0);
  });

  it('decays trust over time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-trust-'));
    const trust = new TrustMetrics(join(dir, 'trust-metrics.json'));

    trust.recordInteraction('did:memphis:a', 'did:memphis:b', 'positive');
    const before = trust.calculateLocalTrust('did:memphis:a', 'did:memphis:b');
    trust.decayTrustOverTime(0.5);
    const after = trust.calculateLocalTrust('did:memphis:a', 'did:memphis:b');

    expect(after).toBeLessThanOrEqual(before);
  });
});
