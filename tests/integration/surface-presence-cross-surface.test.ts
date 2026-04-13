import { beforeEach, describe, expect, it } from 'vitest';

import {
  getActiveSurfacesSnapshot,
  recordSurfaceActivity,
  resetSurfacePresence,
} from '../../src/core/surface-presence.js';
import { executeTuiHostCommand } from '../../src/infra/tui-host/commands.js';

function makeCtx() {
  const lines: Array<{ level: string; text: string }> = [];
  return {
    lines,
    ctx: {
      emitLine: (level: 'info' | 'warning' | 'error', text: string) => {
        lines.push({ level, text });
      },
      signal: new AbortController().signal,
    },
  };
}

describe('cross-surface presence visibility', () => {
  beforeEach(() => {
    resetSurfacePresence();
  });

  it('TUI presence.snapshot capability sees Telegram activity after a Telegram message', async () => {
    recordSurfaceActivity({
      surface: 'telegram',
      actorId: 'telegram:1001',
      tier: 2,
      telegramChatId: 42,
    });

    const { ctx, lines } = makeCtx();
    const result = (await executeTuiHostCommand('presence.snapshot', undefined, ctx)) as {
      snapshots: Array<{ surface: string; telegramChatIds: string[] }>;
      active: number;
      total: number;
    };

    expect(result.total).toBeGreaterThanOrEqual(1);
    const telegramSnap = result.snapshots.find((s) => s.surface === 'telegram');
    expect(telegramSnap).toBeDefined();
    expect(telegramSnap?.telegramChatIds).toContain('42');
    expect(lines.some((l) => l.text.includes('Surfaces:'))).toBe(true);
  });

  it('invoking a TUI host command records TUI presence visible to any /status consumer', async () => {
    const { ctx } = makeCtx();

    try {
      await executeTuiHostCommand('pulse.status', undefined, ctx);
    } catch {
      // pulse.status runs loadPulseEntries() against the local filesystem; we
      // don't care whether it finds a pulse file, only that the top-of-function
      // recordSurfaceActivity call ran before any downstream error.
    }

    const snaps = getActiveSurfacesSnapshot();
    const tui = snaps.find((s) => s.surface === 'tui');
    expect(tui).toBeDefined();
    expect(tui?.tier).toBeGreaterThanOrEqual(2);
    expect(tui?.activityCount).toBeGreaterThanOrEqual(1);
  });

  it('snapshot ordering reflects most-recent-first activity across surfaces', () => {
    recordSurfaceActivity({ surface: 'tui', actorId: 'local', tier: 2, now: 100 });
    recordSurfaceActivity({ surface: 'telegram', actorId: 't:1', tier: 2, now: 200 });
    recordSurfaceActivity({ surface: 'http', actorId: '10.0.0.1', tier: 2, now: 300 });

    const snaps = getActiveSurfacesSnapshot({ now: 300 });
    expect(snaps.map((s) => s.surface)).toEqual(['http', 'telegram', 'tui']);
  });
});
