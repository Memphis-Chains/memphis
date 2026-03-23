import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  assertGatewayExecAuthConfigured,
  enforceGatewayExecAuth,
  enforceGatewayExecPolicy,
  loadGatewayExecPolicy,
} from '../../src/gateway/exec-policy.js';

describe('gateway exec-policy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadGatewayExecPolicy', () => {
    it('returns restricted mode by default', () => {
      const policy = loadGatewayExecPolicy({});
      expect(policy.restrictedMode).toBe(true);
    });

    it('loads default allowlist commands', () => {
      const policy = loadGatewayExecPolicy({});
      expect(policy.allowlist.has('pwd')).toBe(true);
      expect(policy.allowlist.has('ls')).toBe(true);
      expect(policy.allowlist.has('echo')).toBe(true);
      expect(policy.allowlist.has('whoami')).toBe(true);
      expect(policy.allowlist.has('date')).toBe(true);
      expect(policy.allowlist.has('uptime')).toBe(true);
    });

    it('respects GATEWAY_EXEC_RESTRICTED_MODE=false', () => {
      const policy = loadGatewayExecPolicy({ GATEWAY_EXEC_RESTRICTED_MODE: 'false' });
      expect(policy.restrictedMode).toBe(false);
    });

    it('respects custom GATEWAY_EXEC_ALLOWLIST', () => {
      const policy = loadGatewayExecPolicy({ GATEWAY_EXEC_ALLOWLIST: 'cat,grep' });
      expect(policy.allowlist.has('cat')).toBe(true);
      expect(policy.allowlist.has('grep')).toBe(true);
    });
  });

  describe('enforceGatewayExecPolicy', () => {
    it('allows basic allowlisted command', () => {
      const policy = loadGatewayExecPolicy({});
      expect(() => enforceGatewayExecPolicy('pwd', policy)).not.toThrow();
    });

    it('allows ls with flags', () => {
      const policy = loadGatewayExecPolicy({});
      expect(() => enforceGatewayExecPolicy('ls -la', policy)).not.toThrow();
    });

    it('blocks non-allowlisted commands', () => {
      const policy = loadGatewayExecPolicy({});
      expect(() => enforceGatewayExecPolicy('rm -rf /', policy)).toThrow();
    });

    it('blocks shell metacharacters (pipe)', () => {
      const policy = loadGatewayExecPolicy({});
      expect(() => enforceGatewayExecPolicy('ls | cat', policy)).toThrow();
    });

    it('blocks shell metacharacters (semicolon)', () => {
      const policy = loadGatewayExecPolicy({});
      expect(() => enforceGatewayExecPolicy('ls; rm -rf /', policy)).toThrow();
    });

    it('blocks shell metacharacters (backtick)', () => {
      const policy = loadGatewayExecPolicy({});
      expect(() => enforceGatewayExecPolicy('echo `whoami`', policy)).toThrow();
    });

    it('blocks shell metacharacters ($())', () => {
      const policy = loadGatewayExecPolicy({});
      expect(() => enforceGatewayExecPolicy('echo $(cat /etc/passwd)', policy)).toThrow();
    });

    it('blocks shell metacharacters (&&)', () => {
      const policy = loadGatewayExecPolicy({});
      expect(() => enforceGatewayExecPolicy('pwd && rm -rf /', policy)).toThrow();
    });

    it('strips path from command base', () => {
      const policy = loadGatewayExecPolicy({});
      expect(() => enforceGatewayExecPolicy('/bin/pwd', policy)).not.toThrow();
    });

    it('passes in unrestricted mode', () => {
      const policy = loadGatewayExecPolicy({ GATEWAY_EXEC_RESTRICTED_MODE: 'false' });
      expect(() => enforceGatewayExecPolicy('any-command', policy)).not.toThrow();
    });
  });

  describe('auth assertions', () => {
    it('assertGatewayExecAuthConfigured throws without token', () => {
      expect(() => assertGatewayExecAuthConfigured({})).toThrow();
    });

    it('assertGatewayExecAuthConfigured passes with token', () => {
      expect(() => assertGatewayExecAuthConfigured({ authToken: 'secret' })).not.toThrow();
    });

    it('enforceGatewayExecAuth rejects missing header', () => {
      expect(() => enforceGatewayExecAuth(undefined, { authToken: 'secret' })).toThrow();
    });

    it('enforceGatewayExecAuth rejects wrong token', () => {
      expect(() =>
        enforceGatewayExecAuth('Bearer wrong', { authToken: 'secret' }),
      ).toThrow();
    });

    it('enforceGatewayExecAuth passes with correct token', () => {
      expect(() =>
        enforceGatewayExecAuth('Bearer secret', { authToken: 'secret' }),
      ).not.toThrow();
    });
  });
});
