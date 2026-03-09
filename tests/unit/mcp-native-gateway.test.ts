import { describe, expect, it } from 'vitest';
import { invokeNativeMcpAsk } from '../../src/bridges/mcp-native-gateway.js';

describe('mcp native gateway', () => {
  it('maps request to result envelope', async () => {
    const response = await invokeNativeMcpAsk(
      {
        jsonrpc: '2.0',
        id: '1',
        method: 'memphis.ask',
        params: { input: 'hello' },
      },
      async () => ({ output: 'ok', providerUsed: 'local-fallback', timingMs: 1 }),
    );

    expect(response.id).toBe('1');
    expect(response.result.output).toBe('ok');
  });

  it('rejects empty input', async () => {
    await expect(
      invokeNativeMcpAsk(
        {
          jsonrpc: '2.0',
          id: '1',
          method: 'memphis.ask',
          params: { input: '' },
        },
        async () => ({ output: 'ok', providerUsed: 'local-fallback', timingMs: 1 }),
      ),
    ).rejects.toThrow(/missing params.input/);
  });

  it('rejects unsupported method', async () => {
    await expect(
      invokeNativeMcpAsk(
        {
          jsonrpc: '2.0',
          id: '1',
          method: 'memphis.bad' as 'memphis.ask',
          params: { input: 'x' },
        },
        async () => ({ output: 'ok', providerUsed: 'local-fallback', timingMs: 1 }),
      ),
    ).rejects.toThrow(/unsupported method/);
  });
});
