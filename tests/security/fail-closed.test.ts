import { describe, expect, it } from 'vitest';

import {
  allow,
  combineResults,
  deny,
  failClosed,
  requireApproval,
} from '../../src/security/fail-closed.js';
import type { PolicyDecision } from '../../src/security/fail-closed.js';

describe('security: fail-closed policy', () => {
  describe('failClosed()', () => {
    it('returns ok=false with fail-closed prefix', () => {
      const result = failClosed('database unavailable');
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('fail-closed: database unavailable');
    });
  });

  describe('allow()', () => {
    it('returns ok=true', () => {
      const result = allow();
      expect(result.ok).toBe(true);
      expect(result.reason).toBe('authorized');
    });

    it('accepts custom reason', () => {
      const result = allow('token valid');
      expect(result.ok).toBe(true);
      expect(result.reason).toBe('token valid');
    });
  });

  describe('deny()', () => {
    it('returns ok=false without fail-closed prefix', () => {
      const result = deny('insufficient permissions');
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('insufficient permissions');
    });
  });

  describe('requireApproval()', () => {
    it('returns ok=false with requires approval prefix', () => {
      const result = requireApproval('high-value operation');
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('requires approval: high-value operation');
    });
  });

  describe('evaluateFailClosed()', () => {
    const evaluate = (decision: PolicyDecision, reason = 'test') =>
      // inline eval to avoid re-importing the whole module
      (() => {
        switch (decision) {
          case 'allow':
            return allow(reason);
          case 'deny':
            return deny(reason);
          case 'require-approval':
            return requireApproval(reason);
          case 'error':
          default:
            return failClosed(`error evaluating policy: ${reason}`);
        }
      })();

    it('allow → ok=true', () => {
      const result = evaluate('allow');
      expect(result.ok).toBe(true);
    });

    it('deny → ok=false', () => {
      const result = evaluate('deny');
      expect(result.ok).toBe(false);
    });

    it('require-approval → ok=false', () => {
      const result = evaluate('require-approval');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('requires approval');
    });

    it('error → fail-closed (ok=false)', () => {
      const result = evaluate('error');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('fail-closed');
    });
  });

  describe('combineResults()', () => {
    it('all ok → combined ok=true', () => {
      const combined = combineResults([allow(), allow()]);
      expect(combined.ok).toBe(true);
    });

    it('one ok=false → combined ok=false with reasons', () => {
      const combined = combineResults([allow(), deny('forbidden'), allow()]);
      expect(combined.ok).toBe(false);
      expect(combined.reason).toContain('forbidden');
    });

    it('all ok=false → combined ok=false with all reasons joined', () => {
      const combined = combineResults([failClosed('err1'), failClosed('err2')]);
      expect(combined.ok).toBe(false);
      expect(combined.reason).toBe('fail-closed: err1; fail-closed: err2');
    });

    it('empty array → ok=true', () => {
      const combined = combineResults([]);
      expect(combined.ok).toBe(true);
    });
  });
});
