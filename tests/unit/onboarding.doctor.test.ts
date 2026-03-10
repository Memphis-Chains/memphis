import { describe, expect, test } from 'vitest';
import { Doctor } from '../../src/onboarding/doctor.js';

describe('Doctor', () => {
  test('checks all critical components', async () => {
    const doctor = new Doctor();
    const results = await doctor.runDiagnostics();

    expect(results).toHaveProperty('rust');
    expect(results).toHaveProperty('node');
    expect(results).toHaveProperty('bridge');
    expect(results).toHaveProperty('vault');
    expect(results).toHaveProperty('chains');
  });

  test('verifies bridge integrity', async () => {
    const doctor = new Doctor();
    const results = await doctor.runDiagnostics();

    if (results.bridge.status === 'PASS') {
      expect(results.bridge.details).toHaveProperty('exports');
      expect(results.bridge.details?.exports).toContain('chain_append');
    }
  });
});
