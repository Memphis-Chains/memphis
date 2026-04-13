import { beforeEach, describe, expect, it } from 'vitest';

import {
  recordSurfaceActivity,
  resetSurfacePresence,
} from '../../src/core/surface-presence.js';
import { executeTuiHostCommand } from '../../src/infra/tui-host/commands.js';
import {
  runMemphisConfigReload,
  runMemphisConfigShow,
} from '../../src/mcp/tools/config.js';
import { runMemphisPresence } from '../../src/mcp/tools/presence.js';

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

describe('surface parity — MCP mirrors TUI host capabilities (Sprint 7)', () => {
  beforeEach(() => {
    resetSurfacePresence();
  });

  describe('presence.snapshot', () => {
    it('MCP tool exposes the same snapshot shape as the TUI host capability', async () => {
      recordSurfaceActivity({
        surface: 'telegram',
        actorId: 'telegram:42',
        tier: 2,
        telegramChatId: 999,
      });

      // Read MCP before TUI so we compare on equivalent state. TUI's own
      // call records a 'tui' surface activity as a side-effect.
      const mcpBefore = runMemphisPresence();
      const { ctx } = makeCtx();
      const tuiResult = (await executeTuiHostCommand(
        'presence.snapshot',
        undefined,
        ctx,
      )) as { snapshots: unknown[]; active: number; total: number };
      const mcpAfter = runMemphisPresence();

      // Shape parity — both expose the same top-level keys.
      expect(Object.keys(mcpBefore).sort()).toEqual(
        ['active', 'snapshots', 'surfaceStatus', 'total'].sort(),
      );
      // Before TUI ran, MCP saw only the telegram activity.
      expect(mcpBefore.snapshots.map((s) => s.surface)).toEqual(['telegram']);
      // After TUI ran, both agree on the full roster.
      expect(mcpAfter.total).toBe(tuiResult.total);
      const mcpSurfaces = mcpAfter.snapshots.map((s) => s.surface).sort();
      const tuiSurfaces = tuiResult.snapshots
        .map((s) => (s as { surface: string }).surface)
        .sort();
      expect(mcpSurfaces).toEqual(tuiSurfaces);
    });

    it('presence.snapshot is reachable via both TUI and MCP from the same in-process registry', async () => {
      recordSurfaceActivity({
        surface: 'http',
        actorId: '10.0.0.1',
        tier: 2,
      });

      const { ctx } = makeCtx();
      const tuiResult = (await executeTuiHostCommand('presence.snapshot', undefined, ctx)) as {
        snapshots: Array<{ surface: string; tier: number }>;
      };
      const mcpResult = runMemphisPresence();

      const mcpHttp = mcpResult.snapshots.find((s) => s.surface === 'http');
      const tuiHttp = tuiResult.snapshots.find((s) => s.surface === 'http');
      expect(mcpHttp?.tier).toBe(tuiHttp?.tier);
      expect(mcpHttp?.tier).toBe(2);
    });
  });

  describe('config.show', () => {
    it('MCP and TUI both return the same redacted values for known keys', async () => {
      process.env.GEN_MAX_TOKENS = '4096';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-secret';
      try {
        const { ctx } = makeCtx();
        const tuiResult = (await executeTuiHostCommand('config.show', undefined, ctx)) as {
          values: Record<string, string>;
        };
        const mcpResult = runMemphisConfigShow();
        expect(mcpResult.values.GEN_MAX_TOKENS).toBe('4096');
        expect(mcpResult.values.GEN_MAX_TOKENS).toBe(tuiResult.values.GEN_MAX_TOKENS);
        expect(mcpResult.values.ANTHROPIC_API_KEY).toBe('***redacted***');
        expect(mcpResult.values.ANTHROPIC_API_KEY).toBe(tuiResult.values.ANTHROPIC_API_KEY);
      } finally {
        delete process.env.GEN_MAX_TOKENS;
        delete process.env.ANTHROPIC_API_KEY;
      }
    });

    it('config.show with `key` returns just that field', () => {
      process.env.GEN_MAX_TOKENS = '2048';
      try {
        const result = runMemphisConfigShow({ key: 'GEN_MAX_TOKENS' });
        expect(result.requestedKey).toBe('GEN_MAX_TOKENS');
        expect(result.values.GEN_MAX_TOKENS).toBe('2048');
      } finally {
        delete process.env.GEN_MAX_TOKENS;
      }
    });
  });

  describe('config.reload', () => {
    it('returns a structured diff and a classification table', async () => {
      const result = await runMemphisConfigReload();
      expect(typeof result.ok).toBe('boolean');
      expect(Array.isArray(result.changes)).toBe(true);
      expect(Array.isArray(result.classification)).toBe(true);
      // classification mirrors the changes array 1:1
      expect(result.classification.length).toBe(result.changes.length);
    });
  });
});
