/**
 * The HTTP transport reads a body that a multi-byte character straddles.
 *
 * ## The failure this exists for
 *
 * The POST branch of the MCP HTTP transport assembled the request body
 * with `chunk.toString('utf8')` — decoding each chunk on its own. A
 * multi-byte character that straddles a chunk boundary is ONE character,
 * not a character plus a fragment, and decoding the halves separately
 * turns it into two U+FFFD replacement characters.
 *
 * Measured 2026-11-23 on this host, on a real rotation of the `insights`
 * chain: the archive reader had the same pattern, and 20 of 297 lines
 * came back corrupted. See `src/core/utf8-stream.ts`.
 *
 * MCP tool arguments carry the operator's own text, and Polish
 * diacritics are two bytes, so this is not a theoretical shape — it is
 * the shape of every request the operator writes in his own language.
 *
 * The body is captured here by mocking the SDK transport, so the
 * assertion is on the TEXT the server received — not on a status code
 * that a corrupted body would also produce.
 */
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A Polish pangram — every diacritic the operator actually types. */
const POLISH = 'Zażółć gęślą jaźń — Pchnąć w tę łódź jeża lub ośm skrzyń fig.';

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
/** The body the transport handed to the MCP server. */
let capturedBody: unknown = null;

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

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class {
    sessionId = 'fake-session';
    onclose: (() => void) | undefined;
    constructor(
      public options: {
        sessionIdGenerator?: () => string;
        onsessioninitialized?: (sessionId: string) => void;
      },
    ) {}
    async close() {
      return undefined;
    }
    async handleRequest(_req: unknown, res: HttpResponse, body: unknown) {
      capturedBody = body;
      res.statusCode = 200;
      res.end('{"ok":true}');
    }
  },
}));

vi.mock('../../src/mcp/server.js', () => ({
  createMemphisMcpServer: () => ({
    connect: async () => undefined,
    close: async () => undefined,
  }),
}));

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

describe('the MCP HTTP transport reads a body across chunk boundaries', () => {
  beforeEach(() => {
    handler = null;
    capturedBody = null;
  });

  it('hands the server the exact text when a character straddles two chunks', async () => {
    const { serveMcpHttp } = await import('../../src/mcp/transport/http.js');
    const server = await serveMcpHttp(3112);
    expect(handler).not.toBeNull();

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: POLISH, version: '1.0.0' },
      },
    });
    const bytes = Buffer.from(body, 'utf8');

    // The split point: the middle of the two-byte `ó` in "Zażółć".
    const marker = Buffer.from('ó', 'utf8');
    const markerAt = bytes.indexOf(marker);
    expect(markerAt).toBeGreaterThan(0);
    const splitAt = markerAt + 1;

    const request = createRequest('POST', '/mcp');
    const response = createResponse();
    await handler?.(request, response);

    request.emit('data', bytes.subarray(0, splitAt));
    request.emit('data', bytes.subarray(splitAt));
    request.emit('end');

    // The 'end' handler is async — let it settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(capturedBody).not.toBeNull();
    const clientName = (capturedBody as { params?: { clientInfo?: { name?: string } } }).params
      ?.clientInfo?.name;
    expect(clientName).toBe(POLISH);
    expect(clientName).not.toContain('\uFFFD');

    await expect(server.close()).resolves.toBeUndefined();
  });
});
