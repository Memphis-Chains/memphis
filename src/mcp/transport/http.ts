import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { createMemphisMcpServer } from '../server.js';

export async function serveMcpHttp(
  port = 3001,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createMemphisMcpServer();
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const httpServer = createServer(async (req, res) => {
    if (req.url !== '/mcp') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', async () => {
        try {
          const body = raw.length > 0 ? JSON.parse(raw) : {};
          const sessionId = req.headers['mcp-session-id'] as string | undefined;

          let transport: StreamableHTTPServerTransport;
          if (sessionId && transports[sessionId]) {
            transport = transports[sessionId];
          } else if (!sessionId && isInitializeRequest(body)) {
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid) => {
                transports[sid] = transport;
              },
            });
            transport.onclose = () => {
              if (transport.sessionId) delete transports[transport.sessionId];
            };
            await server.connect(transport);
          } else {
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: invalid session' },
                id: null,
              }),
            );
            return;
          }

          await transport.handleRequest(req, res, body);
        } catch {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32700, message: 'parse_error: invalid JSON' },
              id: null,
            }),
          );
        }
      });
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !transports[sessionId]) {
        res.statusCode = 400;
        res.end('Invalid or missing session ID');
        return;
      }
      await transports[sessionId].handleRequest(req, res);
      return;
    }

    res.statusCode = 405;
    res.end('Method not allowed');
  });

  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve()));

  return {
    port,
    close: async () => {
      await Promise.all(Object.values(transports).map(async (transport) => transport.close()));
      await server.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
