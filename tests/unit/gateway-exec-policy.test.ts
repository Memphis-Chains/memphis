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

    it('drops restricted mode when MEMPHIS_AUTONOMY_MODE=full (tier-3 overlay)', () => {
      const policy = loadGatewayExecPolicy({ MEMPHIS_AUTONOMY_MODE: 'full' });
      expect(policy.restrictedMode).toBe(false);
    });

    it('stays restricted when MEMPHIS_AUTONOMY_MODE is any other value', () => {
      for (const mode of ['balanced', 'quiet', 'paranoid']) {
        const policy = loadGatewayExecPolicy({ MEMPHIS_AUTONOMY_MODE: mode });
        expect(policy.restrictedMode).toBe(true);
      }
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
      expect(() => enforceGatewayExecAuth('Bearer wrong', { authToken: 'secret' })).toThrow();
    });

    it('enforceGatewayExecAuth passes with correct token', () => {
      expect(() => enforceGatewayExecAuth('Bearer secret', { authToken: 'secret' })).not.toThrow();
    });

    it('enforceGatewayExecAuth rejects wrong token of same length (constant-time) (#131)', () => {
      expect(() => enforceGatewayExecAuth('Bearer wrongx', { authToken: 'secretx' })).toThrow();
      expect(() => enforceGatewayExecAuth('Bearer secrex', { authToken: 'secrety' })).toThrow();
    });
  });

  describe('GATEWAY_EXEC_BLOCKED_TOKENS enforcement (#130)', () => {
    it('rejects command whose base matches a blocked token', () => {
      const policy = loadGatewayExecPolicy({
        GATEWAY_EXEC_ALLOWLIST: 'ls,rm',
        GATEWAY_EXEC_BLOCKED_TOKENS: 'rm,dd',
      });
      expect(() => enforceGatewayExecPolicy('rm file.txt', policy)).toThrow(/blocked token/i);
    });

    it('rejects command whose arg matches a blocked token exactly', () => {
      const policy = loadGatewayExecPolicy({
        GATEWAY_EXEC_ALLOWLIST: 'ls',
        GATEWAY_EXEC_BLOCKED_TOKENS: 'danger',
      });
      expect(() => enforceGatewayExecPolicy('ls danger', policy)).toThrow(/blocked token/i);
    });

    it('allows command when no blocked token matches', () => {
      const policy = loadGatewayExecPolicy({
        GATEWAY_EXEC_BLOCKED_TOKENS: 'rm,dd',
      });
      expect(() => enforceGatewayExecPolicy('ls -la', policy)).not.toThrow();
    });

    it('full-autonomy mode bypasses blocked tokens (documented)', () => {
      const policy = loadGatewayExecPolicy({
        MEMPHIS_AUTONOMY_MODE: 'full',
        GATEWAY_EXEC_BLOCKED_TOKENS: 'rm',
      });
      expect(() => enforceGatewayExecPolicy('rm -rf /', policy)).not.toThrow();
    });
  });

  describe('curl/wget --output flag blocked (#134)', () => {
    it('blocks curl --output=/path', () => {
      const policy = loadGatewayExecPolicy({ GATEWAY_EXEC_ALLOWLIST: 'curl' });
      expect(() =>
        enforceGatewayExecPolicy('curl --output=/tmp/x http://example.com', policy),
      ).toThrow();
    });

    it('blocks curl -o /path', () => {
      const policy = loadGatewayExecPolicy({ GATEWAY_EXEC_ALLOWLIST: 'curl' });
      expect(() => enforceGatewayExecPolicy('curl -o /tmp/x http://example.com', policy)).toThrow();
    });

    it('blocks wget --output-document=/path', () => {
      const policy = loadGatewayExecPolicy({ GATEWAY_EXEC_ALLOWLIST: 'wget' });
      expect(() =>
        enforceGatewayExecPolicy('wget --output-document=/tmp/x http://example.com', policy),
      ).toThrow();
    });

    it('blocks wget -O /path', () => {
      const policy = loadGatewayExecPolicy({ GATEWAY_EXEC_ALLOWLIST: 'wget' });
      expect(() => enforceGatewayExecPolicy('wget -O /tmp/x http://example.com', policy)).toThrow();
    });

    it('allows curl with safe read-only flags', () => {
      const policy = loadGatewayExecPolicy({ GATEWAY_EXEC_ALLOWLIST: 'curl' });
      expect(() =>
        enforceGatewayExecPolicy('curl --silent http://example.com', policy),
      ).not.toThrow();
    });
  });
});
