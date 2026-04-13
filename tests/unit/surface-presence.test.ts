import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_STALE_MS,
  formatSurfaceStatusLines,
  getActiveSurfacesSnapshot,
  recordSurfaceActivity,
  resetSurfacePresence,
} from '../../src/core/surface-presence.js';

beforeEach(() => {
  resetSurfacePresence();
});

describe('surface-presence registry', () => {
  it('starts empty', () => {
    expect(getActiveSurfacesSnapshot()).toEqual([]);
  });

  it('records a single surface activity', () => {
    recordSurfaceActivity({
      surface: 'telegram',
      actorId: 'telegram:42',
      tier: 2,
      telegramChatId: 123,
      now: 1_000_000,
    });
    const [snap] = getActiveSurfacesSnapshot({ now: 1_000_000 });
    expect(snap?.surface).toBe('telegram');
    expect(snap?.tier).toBe(2);
    expect(snap?.stale).toBe(false);
    expect(snap?.actorIds).toEqual(['telegram:42']);
    expect(snap?.telegramChatIds).toEqual(['123']);
    expect(snap?.activityCount).toBe(1);
  });

  it('aggregates multiple actors on the same surface', () => {
    recordSurfaceActivity({
      surface: 'telegram',
      actorId: 'telegram:1',
      tier: 2,
      telegramChatId: 100,
      now: 1_000,
    });
    recordSurfaceActivity({
      surface: 'telegram',
      actorId: 'telegram:2',
      tier: 2,
      telegramChatId: 200,
      now: 2_000,
    });
    const [snap] = getActiveSurfacesSnapshot({ now: 2_000 });
    expect(snap?.actorIds.sort()).toEqual(['telegram:1', 'telegram:2']);
    expect(snap?.telegramChatIds.sort()).toEqual(['100', '200']);
    expect(snap?.activityCount).toBe(2);
    expect(snap?.lastActivityMs).toBe(2_000);
  });

  it('tracks multiple surfaces independently', () => {
    recordSurfaceActivity({ surface: 'tui', actorId: 'local', tier: 2, now: 1_000 });
    recordSurfaceActivity({ surface: 'telegram', actorId: 't:1', tier: 2, now: 2_000 });
    recordSurfaceActivity({ surface: 'http', actorId: '127.0.0.1', tier: 2, now: 3_000 });
    const snaps = getActiveSurfacesSnapshot({ now: 3_000 });
    expect(snaps.map((s) => s.surface)).toEqual(['http', 'telegram', 'tui']);
    expect(snaps[0]?.lastActivityMs).toBe(3_000);
  });

  it('marks entries older than staleMs as stale', () => {
    recordSurfaceActivity({ surface: 'telegram', actorId: 't:1', tier: 2, now: 0 });
    const snaps = getActiveSurfacesSnapshot({
      now: DEFAULT_STALE_MS + 1,
      staleMs: DEFAULT_STALE_MS,
    });
    expect(snaps[0]?.stale).toBe(true);
  });

  it('honors the tier update on subsequent recordings', () => {
    recordSurfaceActivity({ surface: 'tui', actorId: 'local', tier: 2, now: 1_000 });
    recordSurfaceActivity({ surface: 'tui', actorId: 'local', tier: 3, now: 2_000 });
    const [snap] = getActiveSurfacesSnapshot({ now: 2_000 });
    expect(snap?.tier).toBe(3);
  });

  it('collects tuiHostSessionIds into a set', () => {
    recordSurfaceActivity({
      surface: 'tui',
      actorId: 'local',
      tier: 2,
      tuiHostSessionId: 'tui-host-1',
      now: 1,
    });
    recordSurfaceActivity({
      surface: 'tui',
      actorId: 'local',
      tier: 2,
      tuiHostSessionId: 'tui-host-1',
      now: 2,
    });
    recordSurfaceActivity({
      surface: 'tui',
      actorId: 'local',
      tier: 2,
      tuiHostSessionId: 'tui-host-2',
      now: 3,
    });
    const [snap] = getActiveSurfacesSnapshot({ now: 3 });
    expect(snap?.tuiHostSessionIds.sort()).toEqual(['tui-host-1', 'tui-host-2']);
  });
});

describe('formatSurfaceStatusLines', () => {
  it('returns a "(none)" line when the snapshot is empty', () => {
    expect(formatSurfaceStatusLines([])).toEqual(['Active surfaces: (none)']);
  });

  it('renders a line per surface with age, tier, and actor', () => {
    recordSurfaceActivity({
      surface: 'telegram',
      actorId: 'telegram:42',
      tier: 2,
      telegramChatId: 999,
      now: 1_000_000,
    });
    const snaps = getActiveSurfacesSnapshot({ now: 1_005_000 });
    const lines = formatSurfaceStatusLines(snaps);
    expect(lines[0]).toBe('Active surfaces:');
    expect(lines[1]).toMatch(/telegram/);
    expect(lines[1]).toMatch(/last turn 5s ago/);
    expect(lines[1]).toMatch(/tier 2/);
    expect(lines[1]).toMatch(/\(chat 999\)/);
  });

  it('renders "idle" for stale surfaces', () => {
    recordSurfaceActivity({ surface: 'http', actorId: '10.0.0.1', tier: 2, now: 0 });
    const snaps = getActiveSurfacesSnapshot({
      now: DEFAULT_STALE_MS + 60_000,
      staleMs: DEFAULT_STALE_MS,
    });
    const lines = formatSurfaceStatusLines(snaps);
    expect(lines[1]).toMatch(/http/);
    expect(lines[1]).toMatch(/idle/);
  });

  it('renders +N suffix when multiple actors share a surface', () => {
    recordSurfaceActivity({ surface: 'telegram', actorId: 'a', telegramChatId: 1, now: 1 });
    recordSurfaceActivity({ surface: 'telegram', actorId: 'b', telegramChatId: 2, now: 2 });
    recordSurfaceActivity({ surface: 'telegram', actorId: 'c', telegramChatId: 3, now: 3 });
    const snaps = getActiveSurfacesSnapshot({ now: 3 });
    const lines = formatSurfaceStatusLines(snaps);
    expect(lines[1]).toMatch(/\+2/);
  });
});
