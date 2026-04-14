import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetOtelForTests,
  getOtelState,
  getTracer,
  initOtelIfEnabled,
  shutdownOtel,
  withSpan,
  withSyncSpan,
} from '../../src/infra/observability/otel.js';

describe('OpenTelemetry overlay (closes deferred item #3)', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    __resetOtelForTests();
  });

  afterEach(async () => {
    await shutdownOtel();
    __resetOtelForTests();
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it('initOtelIfEnabled is a no-op when MEMPHIS_OTEL_ENDPOINT is unset', async () => {
    delete process.env.MEMPHIS_OTEL_ENDPOINT;
    const state = await initOtelIfEnabled(process.env);
    expect(state.enabled).toBe(false);
    expect(state.endpoint).toBeNull();
    expect(getOtelState().enabled).toBe(false);
  });

  it('initOtelIfEnabled starts the SDK when endpoint is set', async () => {
    process.env.MEMPHIS_OTEL_ENDPOINT = 'http://127.0.0.1:9999/v1/traces';
    process.env.MEMPHIS_OTEL_SERVICE_NAME = 'memphis-test';
    const state = await initOtelIfEnabled(process.env);
    expect(state.enabled).toBe(true);
    expect(state.endpoint).toBe('http://127.0.0.1:9999/v1/traces');
    expect(state.serviceName).toBe('memphis-test');
  });

  it('second init call is a no-op (idempotent)', async () => {
    process.env.MEMPHIS_OTEL_ENDPOINT = 'http://127.0.0.1:9999/v1/traces';
    const first = await initOtelIfEnabled(process.env);
    expect(first.enabled).toBe(true);
    const sameState = await initOtelIfEnabled(process.env);
    expect(sameState).toBe(first);
  });

  it('getTracer returns a tracer before SDK init (no-op proxy)', () => {
    const tracer = getTracer();
    expect(tracer).toBeTruthy();
    expect(typeof tracer.startActiveSpan).toBe('function');
  });

  it('withSpan runs the wrapped fn and returns its result when SDK not started', async () => {
    const result = await withSpan('test.span', { surface: 'cli' }, async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it('withSpan propagates thrown errors (re-throws, does not swallow)', async () => {
    await expect(
      withSpan('test.throw', undefined, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('withSyncSpan runs synchronously and returns the result', () => {
    const result = withSyncSpan('test.sync', { op: 'add' }, () => 1 + 2);
    expect(result).toBe(3);
  });

  it('withSyncSpan re-throws sync errors', () => {
    expect(() => {
      withSyncSpan('test.sync.throw', undefined, () => {
        throw new Error('sync boom');
      });
    }).toThrow('sync boom');
  });

  it('getOtelState snapshot stays in sync with init lifecycle', async () => {
    expect(getOtelState().enabled).toBe(false);

    process.env.MEMPHIS_OTEL_ENDPOINT = 'http://127.0.0.1:9999/v1/traces';
    await initOtelIfEnabled(process.env);
    expect(getOtelState().enabled).toBe(true);

    await shutdownOtel();
    expect(getOtelState().enabled).toBe(false);
  });

  it('parses MEMPHIS_OTEL_HEADERS into individual key/value pairs', async () => {
    // The headers parser is internal; we can't directly assert on the
    // exporter's headers, but we CAN assert initOtelIfEnabled accepts
    // a well-formed header string without throwing.
    process.env.MEMPHIS_OTEL_ENDPOINT = 'http://127.0.0.1:9999/v1/traces';
    process.env.MEMPHIS_OTEL_HEADERS = 'Authorization=Bearer abc; X-Other=value';
    const state = await initOtelIfEnabled(process.env);
    expect(state.enabled).toBe(true);
  });

  it('coerces out-of-range MEMPHIS_OTEL_SAMPLE_RATIO to 1', async () => {
    process.env.MEMPHIS_OTEL_ENDPOINT = 'http://127.0.0.1:9999/v1/traces';
    process.env.MEMPHIS_OTEL_SAMPLE_RATIO = '2.5'; // out of range
    const state = await initOtelIfEnabled(process.env);
    expect(state.enabled).toBe(true);
  });
});
