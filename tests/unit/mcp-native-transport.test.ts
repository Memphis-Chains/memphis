import { describe, expect, it } from 'vitest';
import { createConnection } from 'node:net';
import { startNativeMcpTransport } from '../../src/bridges/mcp-native-transport.js';

describe('mcp native transport', () => {
  it('serves one request over tcp', async () => {
    const transport = await startNativeMcpTransport(async (request) => ({
      jsonrpc: '2.0',
      id: request.id,
      result: { output: 'ok', providerUsed: 'local-fallback', timingMs: 1 },
    }));

    const response = await new Promise<string>((resolve, reject) => {
      const client = createConnection({ host: transport.host, port: transport.port }, () => {
        client.write(JSON.stringify({ jsonrpc: '2.0', id: 't1', method: 'memphis.ask', params: { input: 'hi' } }));
      });
      let data = '';
      client.on('data', (chunk) => {
        data += chunk.toString('utf8');
      });
      client.on('end', () => resolve(data));
      client.on('error', reject);
    });

    await transport.close();
    expect(response).toContain('"jsonrpc":"2.0"');
    expect(response).toContain('"output":"ok"');
  });
});
