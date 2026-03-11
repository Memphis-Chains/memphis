import { describe, expect, it } from 'vitest';
import { serveMcpHttp } from '../../src/mcp/transport/http.js';
import { serveMcpStdio } from '../../src/mcp/transport/stdio.js';

describe('mcp transport', () => {
  it('starts and stops stdio transport', async () => {
    const srv = await serveMcpStdio();
    await expect(srv.close()).resolves.toBeUndefined();
  });

  it('starts HTTP transport and serves endpoint', async () => {
    const port = 3111;
    const srv = await serveMcpHttp(port);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'GET' });
    expect(response.status).toBe(400);

    await srv.close();
  });
});
