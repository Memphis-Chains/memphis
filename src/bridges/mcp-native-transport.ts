import { createServer, type Socket } from 'node:net';
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

  const server = createServer((socket: Socket) => {
    let buffer = '';
    socket.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');
      try {
        const request = JSON.parse(buffer) as NativeMcpRequest;
        const response = await handler(request);
        socket.write(JSON.stringify(response));
        socket.end();
      } catch {
        // wait for full payload or fail on close
      }
    });
    socket.on('end', () => {
      if (buffer.trim().length === 0) return;
      try {
        JSON.parse(buffer);
      } catch {
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse_error' } }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind native mcp transport');

  return {
    host,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
