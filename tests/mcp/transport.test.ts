import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serveMcpStdio } from '../../src/mcp/transport/stdio.js';

type HttpRequest = EventEmitter & {
  method?: string;
  url?: string;
  headers: Record<string, string>;
};

type HttpResponse = {
  statusCode: number;
  body: string;
  end: (chunk?: string) => void;
  setHeader: (_name: string, _value: string) => void;
};

let handler: ((request: HttpRequest, response: HttpResponse) => void | Promise<void>) | null = null;

vi.mock('node:http', async () => {
  const actual = await vi.importActual<typeof import('node:http')>('node:http');
  return {
    ...actual,
    createServer: vi.fn((requestHandler) => {
      handler = requestHandler as typeof handler;
      return {
        listen: (_port: number, _host: string, callback?: () => void) => callback?.(),
        close: (callback?: (error?: Error) => void) => callback?.(),
      };
    }),
  };
});

function createRequest(method: string, url: string): HttpRequest {
  const request = new EventEmitter() as HttpRequest;
  request.method = method;
  request.url = url;
  request.headers = {};
  return request;
}

function createResponse(): HttpResponse {
  return {
    statusCode: 200,
    body: '',
    end(chunk?: string) {
      this.body = chunk ?? '';
    },
    setHeader() {
      return undefined;
    },
  };
}

describe('mcp transport', () => {
  beforeEach(() => {
    handler = null;
  });

  it('starts and stops stdio transport', async () => {
    const server = await serveMcpStdio();
    await expect(server.close()).resolves.toBeUndefined();
  });

  it('starts HTTP transport and serves endpoint', async () => {
    const { serveMcpHttp } = await import('../../src/mcp/transport/http.js');
    const server = await serveMcpHttp(3111);

    expect(handler).not.toBeNull();
    const request = createRequest('GET', '/mcp');
    const response = createResponse();
    await handler?.(request, response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Invalid or missing session ID');

    await expect(server.close()).resolves.toBeUndefined();
  });
});
