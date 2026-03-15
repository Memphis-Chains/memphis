import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/core/errors.js';
import {
  enforceGatewayExecAuth,
  enforceGatewayExecPolicy,
  loadGatewayExecPolicy,
} from '../../src/gateway/exec-policy.js';
import { execLimiter } from '../../src/infra/http/rate-limit.js';

describe('security: gateway /exec auth bypass', () => {
  it('rejects missing or invalid bearer token', () => {
    expect(() => enforceGatewayExecAuth(undefined, { authToken: 'secret' })).toThrow(AppError);
    expect(() => enforceGatewayExecAuth('Bearer wrong', { authToken: 'secret' })).toThrow(
      /unauthorized/,
    );
    expect(() => enforceGatewayExecAuth('Bearer secret', { authToken: 'secret' })).not.toThrow();
  });

  it('applies strict command allowlist policy', () => {
    const policy = loadGatewayExecPolicy({
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'echo,pwd',
      GATEWAY_EXEC_BLOCKED_TOKENS: '&&,;,|',
    } as NodeJS.ProcessEnv);

    expect(() => enforceGatewayExecPolicy('echo ok', policy)).not.toThrow();
    expect(() => enforceGatewayExecPolicy('bash -c whoami', policy)).toThrow(/allowlist/);
    expect(() => enforceGatewayExecPolicy('echo ok && whoami', policy)).toThrow(
      /blocked shell metacharacter/,
    );
  });

  it('rate limits /exec requests to 10 per minute per key', () => {
    const now = Date.now();
    const key = '127.0.0.1:POST:/exec';
    for (let i = 0; i < 10; i += 1) {
      expect(() => execLimiter.check(key, now)).not.toThrow();
    }
    expect(() => execLimiter.check(key, now)).toThrow(/Rate limit exceeded/);
  });
});
