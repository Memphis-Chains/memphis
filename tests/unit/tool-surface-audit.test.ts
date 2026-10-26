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

  // A tool the native surface executes but the gateway must not advertise
  // stays in the registry (so tier, capabilities and schema have one home)
  // and is absent from the gateway surfaces on purpose. The audit has to
  // know that difference, or it reports a deliberate design as a defect.
  it('does not report a gateway-hidden native tool as missing from the gateway', () => {
    const report = buildToolSurfaceAuditReport({
      MEMPHIS_RUNTIME_ROOT: process.cwd(),
    } as NodeJS.ProcessEnv);

    expect(report.gatewayHidden.length).toBeGreaterThan(0);
    expect(report.gatewayHidden).toContain('memphis_vault_list');
    for (const name of report.gatewayHidden) {
      const gateway = report.surfaces.filter((surface) => surface.surface !== 'registry');
      for (const surface of gateway) {
        expect(surface.missingFromSurface).not.toContain(name);
      }
    }
    // The hidden tool still has to live in the registry — that is the one
    // place its tier and capabilities are recorded.
    const registry = report.surfaces.find((surface) => surface.surface === 'registry');
    for (const name of report.gatewayHidden) {
      expect(registry?.names).toContain(name);
    }
  });
});
