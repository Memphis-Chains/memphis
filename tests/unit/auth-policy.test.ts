import { describe, expect, it } from 'vitest';
import { isAuthRequired } from '../../src/infra/http/auth-policy.js';

describe('auth policy matcher', () => {
  it('matches dynamic route with exact method', () => {
    expect(isAuthRequired('GET', '/v1/sessions/abc/events')).toBe(true);
  });

  it('keeps unknown paths protected by default', () => {
    expect(isAuthRequired('GET', '/v1/unknown')).toBe(true);
  });

  it('treats method matching as strict (lowercase falls back to protected)', () => {
    expect(isAuthRequired('get', '/health')).toBe(true);
  });
});
