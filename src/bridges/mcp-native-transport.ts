import { Socket, createServer } from 'node:net';

import type { NativeMcpRequest, NativeMcpResponse } from './mcp-native-gateway.js';

export type NativeMcpTransportOptions = {
  host?: string;
  port?: number;
};

export async function startNativeMcpTransport(
  handler: (request: NativeMcpRequest) => Promise<NativeMcpResponse>,
  options: NativeMcpTransportOptions = {},
): Promise<{ host: string; port: number; close: () => Promise<void> }> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;

  const MAX_BUFFER_SIZE = 1_000_000; // 1MB
  const BUFFER_TIMEOUT_MS = 5_000; // 5 seconds

  const server = createServer((socket: Socket) => {
    let buffer = '';
    let timeoutId: NodeJS.Timeout | null = null;

    const clearBufferTimeout = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const resetBufferTimeout = () => {
      clearBufferTimeout();
      timeoutId = setTimeout(() => {
        socket.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32000, message: 'buffer_timeout' },
          }),
        );
        socket.end();
      }, BUFFER_TIMEOUT_MS);
    };

    socket.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_BUFFER_SIZE) {
        socket.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32000, message: 'buffer_overflow' },
          }),
        );
        socket.end();
        return;
      }
      resetBufferTimeout();
      try {
        const parsed: unknown = JSON.parse(buffer);
        clearBufferTimeout();
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          !('jsonrpc' in parsed) ||
          !('method' in parsed) ||
          !('id' in parsed)
        ) {
          socket.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32600, message: 'invalid_request' },
            }),
          );
          socket.end();
          return;
        }
        const request = parsed as NativeMcpRequest;
        const response = await handler(request);
        socket.write(JSON.stringify(response));
        socket.end();
      } catch {
        // wait for full payload or fail on close
      }
    });
    socket.on('end', () => {
      clearBufferTimeout();
      if (buffer.trim().length === 0) return;
      try {
        JSON.parse(buffer);
      } catch {
        socket.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'parse_error' },
          }),
        );
      }
    });
    socket.on('close', () => {
      clearBufferTimeout();
    });
    socket.on('error', () => {
      clearBufferTimeout();
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('failed to bind native mcp transport');

  return {
    host,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
