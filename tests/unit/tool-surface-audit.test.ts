import { describe, expect, it } from 'vitest';

import { buildToolSurfaceAuditReport } from '../../src/gateway/tool-surface-audit.js';

describe('tool surface audit', () => {
  it('keeps registry, in-process executor, and MCP server tool names aligned', () => {
    const report = buildToolSurfaceAuditReport({
      MEMPHIS_RUNTIME_ROOT: process.cwd(),
    } as NodeJS.ProcessEnv);

    expect(report.ok).toBe(true);
    expect(report.registryCount).toBeGreaterThan(0);
    expect(report.surfaces.map((surface) => surface.surface).sort()).toEqual(
      ['inProcessExecutor', 'mcpServer', 'registry'].sort(),
    );
    for (const surface of report.surfaces) {
      expect(surface.names).toHaveLength(report.registryCount);
      expect(surface.missingFromRegistry).toEqual([]);
      expect(surface.missingFromSurface).toEqual([]);
    }
  });
});
