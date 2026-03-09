import { describe, expect, it } from 'vitest';
import { createDecision, transitionDecision } from '../../src/core/decision-lifecycle.js';

describe('decision lifecycle', () => {
  it('creates proposed decision with schema v1', () => {
    const d = createDecision({ id: 'd1', title: 'Pick provider', options: ['ollama', 'openai'] });
    expect(d.status).toBe('proposed');
    expect(d.schemaVersion).toBe(1);
  });

  it('allows valid transition chain', () => {
    const d1 = createDecision({ id: 'd2', title: 'Pick model' });
    const d2 = transitionDecision(d1, 'accepted');
    const d3 = transitionDecision(d2, 'implemented');
    const d4 = transitionDecision(d3, 'verified');
    expect(d4.status).toBe('verified');
  });

  it('rejects invalid transition', () => {
    const d = createDecision({ id: 'd3', title: 'Pick config' });
    expect(() => transitionDecision(d, 'verified')).toThrow(/invalid transition/);
  });
});
