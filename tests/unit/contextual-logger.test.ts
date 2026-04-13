import { beforeEach, describe, expect, it } from 'vitest';

import {
  createContextualLogger,
  resetRootLogger,
  withContext,
} from '../../src/infra/logging/contextual.js';

beforeEach(() => {
  resetRootLogger();
});

describe('createContextualLogger', () => {
  it('returns a logger that carries the supplied context fields', () => {
    const logger = createContextualLogger({
      requestId: 'req-1',
      surface: 'http',
      actorId: 'operator',
    });
    // Pino bindings surface the fields attached via child(..).
    const bindings = (logger as unknown as { bindings(): Record<string, unknown> }).bindings();
    expect(bindings.requestId).toBe('req-1');
    expect(bindings.surface).toBe('http');
    expect(bindings.actorId).toBe('operator');
  });

  it('strips undefined, null, and empty-string fields', () => {
    const logger = createContextualLogger({
      requestId: 'req-2',
      actorId: undefined,
      turnId: '',
    });
    const bindings = (logger as unknown as { bindings(): Record<string, unknown> }).bindings();
    expect(bindings.requestId).toBe('req-2');
    expect('actorId' in bindings).toBe(false);
    expect('turnId' in bindings).toBe(false);
  });

  it('withContext extends an existing logger without overwriting prior fields', () => {
    const parent = createContextualLogger({ requestId: 'req-3', surface: 'http' });
    const extended = withContext(parent, { turnId: 'turn-a' });
    const bindings = (extended as unknown as { bindings(): Record<string, unknown> }).bindings();
    expect(bindings.requestId).toBe('req-3');
    expect(bindings.surface).toBe('http');
    expect(bindings.turnId).toBe('turn-a');
  });

  it('accepts arbitrary extra fields via the index signature', () => {
    const logger = createContextualLogger({
      requestId: 'req-4',
      customLabel: 'value',
    });
    const bindings = (logger as unknown as { bindings(): Record<string, unknown> }).bindings();
    expect(bindings.customLabel).toBe('value');
  });
});
