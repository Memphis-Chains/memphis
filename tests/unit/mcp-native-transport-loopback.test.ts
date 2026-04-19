import { describe, expect, it } from 'vitest';

import { startNativeMcpTransport } from '../../src/bridges/mcp-native-transport.ts';

/**
 * Regression net for #139. Native MCP transport has no auth by design
 * (local trust). Must fail-closed on non-loopback bind so a future caller
 * can't silently expose unauthenticated MCP on the network.
 */

describe('native MCP transport — loopback enforcement (#139)', () => {
  it('rejects binding to 0.0.0.0', async () => {
    await expect(
      startNativeMcpTransport(async () => ({ jsonrpc: '2.0', id: 1, result: {} }), {
        host: '0.0.0.0',
      }),
    ).rejects.toThrow(/non-loopback/);
  });

  it('rejects binding to a public IP', async () => {
    await expect(
      startNativeMcpTransport(async () => ({ jsonrpc: '2.0', id: 1, result: {} }), {
        host: '1.2.3.4',
      }),
    ).rejects.toThrow(/non-loopback/);
  });

  it('accepts 127.0.0.1', async () => {
    const t = await startNativeMcpTransport(async () => ({ jsonrpc: '2.0', id: 1, result: {} }), {
      host: '127.0.0.1',
      port: 0,
    });
    await t.close();
    expect(t.host).toBe('127.0.0.1');
  });

  it('accepts ::1', async () => {
    const t = await startNativeMcpTransport(async () => ({ jsonrpc: '2.0', id: 1, result: {} }), {
      host: '::1',
      port: 0,
    });
    await t.close();
    expect(t.host).toBe('::1');
  });

  it('default (no host option) still binds to loopback', async () => {
    const t = await startNativeMcpTransport(async () => ({ jsonrpc: '2.0', id: 1, result: {} }), {
      port: 0,
    });
    await t.close();
    expect(t.host).toBe('127.0.0.1');
  });
});
