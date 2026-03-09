import { describe, expect, it } from 'vitest';
import { inferDecisionFromText } from '../../src/core/decision-gate.js';

describe('decision gate', () => {
  it('detects decision pattern', () => {
    const out = inferDecisionFromText('Decyduję: provider - ollama');
    expect(out.detected).toBe(true);
    expect(out.confidence).toBeGreaterThan(0.6);
  });

  it('returns not detected for neutral text', () => {
    const out = inferDecisionFromText('zwykła notatka bez decyzji');
    expect(out.detected).toBe(false);
  });
});
