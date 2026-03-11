import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/core/errors.js';

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

async function createGateway(authToken?: string) {
  const { Gateway } = await import('../../src/gateway/server.js');
  const dir = mkdtempSync(join(tmpdir(), 'memphis-v5-gw-'));
  const dbFile = join(dir, 'gw.db');
  envForTest(dbFile);
  const gateway = new Gateway({ port: 19089, host: '127.0.0.1', authToken }, dir, dir);
  await gateway.start();
  return { gateway, dir };
}

async function performRequest(input: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}) {
  if (!capturedHandler) {
    throw new Error('gateway handler not initialized');
  }

  const request = new EventEmitter() as GatewayRequest;
  request.method = input.method;
  request.url = input.path;
  request.headers = {
    host: '127.0.0.1:19089',
    ...(input.headers ?? {}),
  };
  request.socket = { remoteAddress: '127.0.0.1' };

  let statusCode = 200;
  const responseHeaders: Record<string, string> = {};
  let responseBody = '';
  const response: GatewayResponse = {
    setHeader(name: string, value: string) {
      responseHeaders[name.toLowerCase()] = value;
    },
    writeHead(code: number, headers?: Record<string, string>) {
      statusCode = code;
      for (const [name, value] of Object.entries(headers ?? {})) {
        responseHeaders[name.toLowerCase()] = value;
      }
    },
    end(chunk?: string) {
      responseBody = chunk ?? '';
    },
  };

  const requestPromise = Promise.resolve(capturedHandler(request, response));
  queueMicrotask(() => {
    if (input.rawBody !== undefined) {
      request.emit('data', input.rawBody);
    } else if (input.body !== undefined) {
      request.emit('data', JSON.stringify(input.body));
    }
    request.emit('end');
  });
  await requestPromise;

  return {
    statusCode,
    headers: responseHeaders,
    json: () => (responseBody ? JSON.parse(responseBody) : {}),
  };
}

describe('Gateway e2e', () => {
  beforeEach(() => {
    capturedHandler = null;
    delete process.env.GATEWAY_EXEC_RESTRICTED_MODE;
    delete process.env.GATEWAY_EXEC_ALLOWLIST;
  });

  it('fails fast when /exec auth token is missing', async () => {
    const { Gateway } = await import('../../src/gateway/server.js');
    const dir = mkdtempSync(join(tmpdir(), 'memphis-v5-gw-'));
    const dbFile = join(dir, 'gw.db');
    envForTest(dbFile);

    expect(() => new Gateway({ port: 19088, host: '127.0.0.1' }, dir, dir)).toThrowError(AppError);
  });

  it('maps validation error contract for /provider/chat', async () => {
    await createGateway('tok');

    const response = await performRequest({
      method: 'POST',
      path: '/provider/chat',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tok',
        'x-request-id': 'gw-1',
      },
      body: {},
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error?: { code?: string; requestId?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.requestId).toBe('gw-1');
  });

  it('returns validation error for malformed JSON body', async () => {
    await createGateway('tok');

    const response = await performRequest({
      method: 'POST',
      path: '/provider/chat',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tok',
        'x-request-id': 'gw-4',
      },
      rawBody: '{"input":',
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error?: { code?: string; requestId?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.requestId).toBe('gw-4');
  });

  it('blocks /exec command outside allowlist in restricted mode', async () => {
    process.env.GATEWAY_EXEC_RESTRICTED_MODE = 'true';
    process.env.GATEWAY_EXEC_ALLOWLIST = 'echo,pwd';
    await createGateway('tok');

    const response = await performRequest({
      method: 'POST',
      path: '/exec',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tok',
        'x-request-id': 'gw-2',
      },
      body: { command: 'cat /etc/hosts' },
    });

    expect(response.statusCode).toBe(403);
    const body = response.json() as { error?: { code?: string; requestId?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.requestId).toBe('gw-2');
  });

  it('requires auth for /exec even if route exists', async () => {
    process.env.GATEWAY_EXEC_RESTRICTED_MODE = 'true';
    process.env.GATEWAY_EXEC_ALLOWLIST = 'echo';
    await createGateway('tok');

    const response = await performRequest({
      method: 'POST',
      path: '/exec',
      headers: { 'content-type': 'application/json', 'x-request-id': 'gw-3' },
      body: { command: 'echo ok' },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json() as { error?: { code?: string; requestId?: string } };
    expect(body.error?.code).toBe('UNAUTHORIZED');
    expect(body.error?.requestId).toBe('gw-3');
  });
});
