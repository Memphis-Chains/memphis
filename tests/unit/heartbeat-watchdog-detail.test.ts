import { describe, expect, it } from 'vitest';

import { buildHeartbeatDetail } from '../../src/infra/runtime/heartbeat-watchdog.js';

describe('buildHeartbeatDetail', () => {
  it('returns undefined when every check is ok', () => {
    expect(
      buildHeartbeatDetail([
        { name: 'chain_adapter', status: 'ok' },
        { name: 'vault_bridge', status: 'ok', message: 'rust disabled' },
      ]),
    ).toBeUndefined();
  });

  it('names each failing check with its status and message', () => {
    const detail = buildHeartbeatDetail([
      { name: 'chain_adapter', status: 'ok' },
      { name: 'embed_bridge', status: 'warn', message: 'bridge unavailable' },
      { name: 'memory', status: 'warn', message: '475/524 MB (91%)' },
    ]);
    expect(detail).toBe('warn:embed_bridge:bridge unavailable warn:memory:475/524 MB (91%)');
  });

  it('drops the message suffix when the check has no message', () => {
    const detail = buildHeartbeatDetail([
      { name: 'chain_adapter', status: 'fail' },
    ]);
    expect(detail).toBe('fail:chain_adapter');
  });

  it('surfaces both warn and fail together', () => {
    const detail = buildHeartbeatDetail([
      { name: 'vault_bridge', status: 'fail', message: 'bridge unavailable' },
      { name: 'memory', status: 'warn', message: '92%' },
    ]);
    expect(detail).toBe('fail:vault_bridge:bridge unavailable warn:memory:92%');
  });
});
