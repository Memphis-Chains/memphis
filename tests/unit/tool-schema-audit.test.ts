import { describe, expect, it } from 'vitest';

import { buildToolSchemaAuditReport } from '../../src/gateway/tool-schema-audit.js';

describe('tool schema audit', () => {
  it('reports registry-to-executor schema key drift without blocking runtime checks', () => {
    const report = buildToolSchemaAuditReport({
      ...process.env,
      MEMPHIS_RUNTIME_ROOT: process.cwd(),
    } as NodeJS.ProcessEnv);

    expect(report.checked).toBeGreaterThan(0);
    expect(Array.isArray(report.mismatches)).toBe(true);
    expect(Array.isArray(report.requiredMismatches)).toBe(true);
    expect(Array.isArray(report.typeMismatches)).toBe(true);
    expect(Array.isArray(report.constraintMismatches)).toBe(true);
    expect(Array.isArray(report.missingRegistrySchema)).toBe(true);
    expect(Array.isArray(report.missingExecutorSchema)).toBe(true);
    expect(Array.isArray(report.missingMcpSchema)).toBe(true);

    for (const entry of report.mismatches) {
      expect(entry.name).toMatch(/^memphis_/);
      expect(
        entry.missingFromRegistry.length +
          entry.missingFromExecutor.length +
          entry.missingFromMcp.length,
      ).toBeGreaterThan(0);
    }

    for (const entry of report.requiredMismatches) {
      expect(entry.name).toMatch(/^memphis_/);
      expect(
        entry.missingRequiredFromRegistry.length +
          entry.missingRequiredFromExecutor.length +
          entry.missingRequiredFromMcp.length,
      ).toBeGreaterThan(0);
    }

    for (const entry of report.typeMismatches) {
      expect(entry.name).toMatch(/^memphis_/);
      expect(entry.key.length).toBeGreaterThan(0);
      expect(
        new Set([entry.registryType, entry.executorType, entry.mcpType]).size,
      ).toBeGreaterThan(1);
    }

    for (const entry of report.constraintMismatches) {
      expect(entry.name).toMatch(/^memphis_/);
      expect(entry.keyPath.length).toBeGreaterThan(0);
      expect(
        new Set([
          entry.registryConstraints,
          entry.executorConstraints,
          entry.mcpConstraints,
        ]).size,
      ).toBeGreaterThan(1);
    }
  });

  it('keeps repaired batch-2 and batch-3 tools out of schema drift', () => {
    const report = buildToolSchemaAuditReport({
      ...process.env,
      MEMPHIS_RUNTIME_ROOT: process.cwd(),
    } as NodeJS.ProcessEnv);

    const repaired = new Set([
      'memphis_repair',
      'memphis_self_modify',
      'memphis_recall',
      'memphis_search',
      'memphis_code_read',
      'memphis_brave_search',
      'memphis_chain_query',
      'memphis_grep',
      'memphis_glob',
    ]);
    const allowedConstraintDrift = new Set([
      'memphis_chain_query:offset',
      'memphis_glob:pattern',
      'memphis_grep:context',
      'memphis_grep:pattern',
    ]);

    expect(report.mismatches.filter((entry) => repaired.has(entry.name))).toEqual([]);
    expect(report.typeMismatches.filter((entry) => repaired.has(entry.name))).toEqual([]);
    expect(
      report.constraintMismatches.filter(
        (entry) => repaired.has(entry.name) && !allowedConstraintDrift.has(`${entry.name}:${entry.keyPath}`),
      ),
    ).toEqual([]);
  });
});
