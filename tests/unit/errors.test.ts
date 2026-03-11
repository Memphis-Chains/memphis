import { describe, expect, it } from 'vitest';

import { AppError, errorTemplates, formatCliError, toAppError } from '../../src/core/errors.js';

describe('errors mapping', () => {
  it('passes through AppError', () => {
    const err = new AppError('VALIDATION_ERROR', 'bad input', 400);
    expect(toAppError(err)).toBe(err);
  });

  it('maps provider config errors', () => {
    const mapped = toAppError(new Error('Provider not configured: x'));
    expect(mapped.code).toBe('PROVIDER_UNAVAILABLE');
    expect(mapped.statusCode).toBe(503);
  });

  it('maps unknown errors to internal', () => {
    const mapped = toAppError(new Error('random'));
    expect(mapped.code).toBe('INTERNAL_ERROR');
    expect(mapped.statusCode).toBe(500);
  });

  it('creates actionable missing .env errors', () => {
    const err = errorTemplates.missingEnv({ missingKeys: ['DEFAULT_PROVIDER'] });
    expect(err.code).toBe('MISSING_ENV');
    expect(err.suggestion).toContain('.env.example');
  });

  it('maps network failures to actionable errors', () => {
    const error = new Error('fetch failed');
    const mapped = toAppError(error);
    expect(mapped.code).toBe('NETWORK_ERROR');
    expect(mapped.suggestion).toContain('service is running');
  });

  it('shows stack traces only in verbose mode', () => {
    const error = new Error('boom');
    const normal = formatCliError(error, { verbose: false });
    const verbose = formatCliError(error, { verbose: true });
    expect(normal).not.toContain('Error: boom');
    expect(verbose).toContain('Error: boom');
  });
});
