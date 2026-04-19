import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { OrchestrationService } from '../src/modules/orchestration/service.js';
import { handleTuiCommand, type Observability, type TuiState } from '../src/tui/index.js';
import { appendSnapshot, loadSnapshots } from '../src/tui/observability-store.js';
import { RootLayout } from '../src/tui/RootLayout.js';

function createState(): TuiState {
  return {
    provider: 'auto',
    strategy: 'default',
    model: undefined,
    dashboardData: undefined,
    screenLines: {},
    sessionRecords: [],
    chatMessages: [],
    generatingSince: undefined,
    lastStep: undefined,
  };
}

function createObservability(): Observability {
  return {
    requests: 3,
    fallbackAttempts: 1,
    totalAttempts: 4,
    avgTimingMs: 123,
    recentTimingsMs: [120, 126],
    lastProvider: 'ollama',
    lastPersistedTs: '2026-03-26T10:00:00.000Z',
  };
}

describe('handleTuiCommand', () => {
  it('switches screens through the extracted command handler', async () => {
    const state = createState();
    const layout = new RootLayout('chat');
    const history: string[] = [];

    const result = await handleTuiCommand('/screen vault', {
      state,
      observability: createObservability(),
      observabilityPath: join(tmpdir(), 'memphis-test-obs.json'),
      orchestration: {} as OrchestrationService,
      setScreen(next, source) {
        layout.setScreen(next);
        history.push(source);
      },
      pushHistory(value) {
        history.push(value);
      },
      persistObservability: vi.fn(),
      loadGuideLines: () => [],
      refreshScreen: vi.fn(),
    });

    expect(result).toBe('handled');
    expect(layout.screen).toBe('vault');
    expect(history.at(-1)).toBe('ok: screen=vault');
  });

  it('resets observability snapshots without touching the readline loop', async () => {
    const state = createState();
    const observability = createObservability();
    const dir = mkdtempSync(join(tmpdir(), 'memphis-tui-cmd-'));
    const observabilityPath = join(dir, 'obs.json');

    appendSnapshot(observabilityPath, {
      ts: '2026-03-26T10:00:00.000Z',
      requests: 2,
      fallbackAttempts: 1,
      totalAttempts: 3,
      avgTimingMs: 99,
      recentTimingsMs: [99],
      lastProvider: 'ollama',
    });

    const history: string[] = [];

    try {
      const result = await handleTuiCommand('/obs reset', {
        state,
        observability,
        observabilityPath,
        orchestration: {} as OrchestrationService,
        setScreen: vi.fn(),
        pushHistory(value) {
          history.push(value);
        },
        persistObservability: vi.fn(),
        loadGuideLines: () => [],
        refreshScreen: vi.fn(),
      });

      expect(result).toBe('handled');
      expect(loadSnapshots(observabilityPath)).toHaveLength(0);
      expect(observability.requests).toBe(0);
      expect(observability.lastProvider).toBeUndefined();
      expect(history.at(-1)).toContain('[obs] reset completed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns exit for quit commands', async () => {
    const result = await handleTuiCommand('/exit', {
      state: createState(),
      observability: createObservability(),
      observabilityPath: join(tmpdir(), 'memphis-test-obs.json'),
      orchestration: {} as OrchestrationService,
      setScreen: vi.fn(),
      pushHistory: vi.fn(),
      persistObservability: vi.fn(),
      loadGuideLines: () => [],
      refreshScreen: vi.fn(),
    });

    expect(result).toBe('exit');
  });
});
