import {
  formatSurfaceStatusLines,
  getActiveSurfacesSnapshot,
  type SurfaceActivitySnapshot,
} from '../../core/surface-presence.js';

export interface MemphisPresenceOutput {
  snapshots: SurfaceActivitySnapshot[];
  active: number;
  total: number;
  surfaceStatus: string[];
}

/**
 * Cross-surface presence snapshot. Matches the shape returned by the TUI
 * host capability `presence.snapshot` and the `/v1/ops/status` payload so
 * MCP-speaking clients see the same data as every other surface.
 */
export function runMemphisPresence(): MemphisPresenceOutput {
  const snapshots = getActiveSurfacesSnapshot();
  const active = snapshots.filter((s) => !s.stale).length;
  return {
    snapshots,
    active,
    total: snapshots.length,
    surfaceStatus: formatSurfaceStatusLines(snapshots),
  };
}
