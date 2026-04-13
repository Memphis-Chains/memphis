import { describe, expect, it } from 'vitest';

import { detectSupervisor } from '../../src/infra/runtime/self-restart.js';

describe('detectSupervisor', () => {
  it('detects systemd via NOTIFY_SOCKET', () => {
    const result = detectSupervisor({ NOTIFY_SOCKET: '/run/systemd/notify' } as NodeJS.ProcessEnv);
    expect(result.kind).toBe('systemd');
    expect(result.detail).toContain('NOTIFY_SOCKET');
  });

  it('detects systemd via INVOCATION_ID', () => {
    const result = detectSupervisor({ INVOCATION_ID: 'abc123' } as NodeJS.ProcessEnv);
    expect(result.kind).toBe('systemd');
    expect(result.detail).toContain('INVOCATION_ID');
  });

  it('detects PM2 via pm_id', () => {
    const result = detectSupervisor({ pm_id: '0' } as NodeJS.ProcessEnv);
    expect(result.kind).toBe('pm2');
  });

  it('detects PM2 via PM2_HOME alone', () => {
    const result = detectSupervisor({ PM2_HOME: '/home/x/.pm2' } as NodeJS.ProcessEnv);
    expect(result.kind).toBe('pm2');
  });

  it('returns null when no supervisor signal is present', () => {
    const result = detectSupervisor({} as NodeJS.ProcessEnv);
    expect(result.kind).toBe(null);
    expect(result.detail).toBe('no supervisor detected');
  });
});
