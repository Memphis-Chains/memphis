import { describe, expect, it } from 'vitest';

import { NATIVE_TOOL_CONTRACTS } from '../../src/gateway/tool-contract.js';
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
    const registryNames = report.surfaces.find((surface) => surface.surface === 'registry')!.names;
    const nativeOnlyNames = new Set(
      NATIVE_TOOL_CONTRACTS.filter((contract) => contract.gatewayHidden).map(
        (contract) => contract.name,
      ),
    );
    for (const surface of report.surfaces) {
      const expected =
        surface.surface === 'registry'
          ? registryNames
          : registryNames.filter((name) => !nativeOnlyNames.has(name));
      expect(surface.names).toEqual(expected);
      expect(surface.missingFromRegistry).toEqual([]);
      expect(surface.missingFromSurface).toEqual([]);
    }
  });
});
