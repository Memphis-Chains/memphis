import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import {
  assertGatewayExecAuthConfigured,
  enforceGatewayExecAuth,
  enforceGatewayExecPolicy,
  loadGatewayExecPolicy,
} from '../../src/gateway/exec-policy.js';

describe('gateway exec policy', () => {
  it('allows default allowlisted command in restricted mode', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'echo,pwd',
    });

    expect(() => enforceGatewayExecPolicy('echo ok', policy)).not.toThrow();
  });

  it('blocks command outside allowlist', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'echo,pwd',
    });

    expect(() => enforceGatewayExecPolicy('cat /etc/passwd', policy)).toThrowError(AppError);
  });

  it('blocks shell chaining token in restricted mode', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'echo,pwd',
      GATEWAY_EXEC_BLOCKED_TOKENS: '&&,||',
    });

    expect(() => enforceGatewayExecPolicy('echo ok && pwd', policy)).toThrowError(AppError);
  });

  it('allows non-restricted mode for legacy compatibility', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'false',
      GATEWAY_EXEC_ALLOWLIST: 'echo',
    });

    expect(() => enforceGatewayExecPolicy('cat /etc/hosts', policy)).not.toThrow();
  });

  it('requires gateway exec auth token to be configured', () => {
    expect(() => assertGatewayExecAuthConfigured({})).toThrowError(AppError);
  });

  it('rejects unauthorized gateway exec requests', () => {
    expect(() => enforceGatewayExecAuth(undefined, { authToken: 'secret' })).toThrowError(AppError);
    expect(() => enforceGatewayExecAuth('Bearer wrong', { authToken: 'secret' })).toThrowError(AppError);
    expect(() => enforceGatewayExecAuth('Bearer secret', { authToken: 'secret' })).not.toThrow();
  });
});
