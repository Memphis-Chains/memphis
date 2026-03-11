import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

type FakeSocket = EventEmitter & {
  writes: string[];
  write: (chunk: string) => void;
  end: () => void;
};

let connectionHandler: ((socket: FakeSocket) => void) | null = null;

vi.mock('node:net', async () => {
  const actual = await vi.importActual<typeof import('node:net')>('node:net');
  return {
    ...actual,
    createServer: vi.fn((handler) => {
      connectionHandler = handler as typeof connectionHandler;
      return {
        listen: (_port: number, _host: string, callback?: () => void) => callback?.(),
        address: () => ({ port: 3210 }),
        close: (callback?: (error?: Error) => void) => callback?.(),
      };
    }),
  };
});

function createSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.writes = [];
  socket.write = (chunk: string) => {
    socket.writes.push(chunk);
  };
  socket.end = () => undefined;
  return socket;
}

describe('mcp native transport', () => {
  beforeEach(() => {
    connectionHandler = null;
  });

  it('serves one request over tcp', async () => {
    const { startNativeMcpTransport } = await import('../../src/bridges/mcp-native-transport.js');
    const transport = await startNativeMcpTransport(async (request) => ({
      jsonrpc: '2.0',
      id: request.id,
      result: { output: 'ok', providerUsed: 'local-fallback', timingMs: 1 },
    }));

    expect(connectionHandler).not.toBeNull();
    const socket = createSocket();
    connectionHandler?.(socket);
    socket.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 't1',
          method: 'memphis.ask',
          params: { input: 'hi' },
        }),
      ),
    );

    await Promise.resolve();
    await expect(transport.close()).resolves.toBeUndefined();
    expect(socket.writes.join('')).toContain('"jsonrpc":"2.0"');
    expect(socket.writes.join('')).toContain('"output":"ok"');
  });
});
