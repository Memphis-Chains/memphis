import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { globalLimiter, sensitiveLimiter } from '../../src/infra/http/rate-limit.js';

type GatewayRequest = EventEmitter & {
  method: string;
  url: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
};

type GatewayResponse = {
  setHeader: (name: string, value: string) => void;
  writeHead: (code: number, headers?: Record<string, string>) => void;
  end: (chunk?: string) => void;
};

type RequestHandler = (req: GatewayRequest, res: GatewayResponse) => void | Promise<void>;

let capturedHandler: RequestHandler | null = null;

vi.mock('node:http', async () => {
  const actual = await vi.importActual<typeof import('node:http')>('node:http');
  return {
    ...actual,
    createServer: vi.fn((handler: RequestHandler) => {
      capturedHandler = handler;
      return {
        listen: (_port: number, _host: string, callback?: () => void) => callback?.(),
      };
    }),
  };
});

function envForTest(dbFile: string): void {
  process.env.NODE_ENV = 'test';
  process.env.HOST = '127.0.0.1';
  process.env.PORT = '0';
  process.env.LOG_LEVEL = 'error';
  process.env.DEFAULT_PROVIDER = 'local-fallback';
  process.env.LOCAL_FALLBACK_ENABLED = 'true';
  process.env.GEN_TIMEOUT_MS = '30000';
  process.env.GEN_MAX_TOKENS = '512';
  process.env.GEN_TEMPERATURE = '0.4';
  process.env.DATABASE_URL = `file:${dbFile}`;
}

async function createGateway() {
  const { Gateway } = await import('../../src/gateway/server.js');
  const dir = mkdtempSync(join(tmpdir(), 'memphis-v5-gw-rate-'));
  const dbFile = join(dir, 'gw-rate.db');
  envForTest(dbFile);
  const gateway = new Gateway({ port: 19091, host: '127.0.0.1', authToken: 'tok' }, dir, dir);
  await gateway.start();
}

async function performRequest(path: string) {
  if (!capturedHandler) throw new Error('gateway handler not initialized');

  const request = new EventEmitter() as GatewayRequest;
  request.method = 'GET';
  request.url = path;
  request.headers = { host: '127.0.0.1:19091' };
  request.socket = { remoteAddress: '127.0.0.2' };

  let statusCode = 200;
  const response: GatewayResponse = {
    setHeader: () => {},
    writeHead: (code: number) => {
      statusCode = code;
    },
    end: () => {},
  };

  const requestPromise = Promise.resolve(capturedHandler(request, response));
  queueMicrotask(() => request.emit('end'));
  await requestPromise;
  return statusCode;
}

describe('security: rate limit consistency', () => {
  beforeEach(() => {
    capturedHandler = null;
  });

  it('enforces standardized limiter thresholds (100 global, 10 sensitive)', () => {
    const now = Date.now();
    const globalKey = `rate-consistency-global-${now}`;
    for (let i = 0; i < 100; i += 1) {
      expect(() => globalLimiter.check(globalKey, now)).not.toThrow();
    }
    expect(() => globalLimiter.check(globalKey, now)).toThrow(/Rate limit exceeded/);

    const sensitiveKey = `rate-consistency-sensitive-${now}`;
    for (let i = 0; i < 10; i += 1) {
      expect(() => sensitiveLimiter.check(sensitiveKey, now)).not.toThrow();
    }
    expect(() => sensitiveLimiter.check(sensitiveKey, now)).toThrow(/Rate limit exceeded/);
  });

  it('applies global limiter in gateway routes', async () => {
    await createGateway();

    let status = 200;
    for (let i = 0; i < 101; i += 1) {
      status = await performRequest('/status');
    }

    expect(status).toBe(429);
  });
});
