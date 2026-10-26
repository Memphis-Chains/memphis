import { describe, expect, it } from 'vitest';

import { requireToolPolicy } from '../../src/gateway/native-tool-policy.js';
import { TOOL_REGISTRY } from '../../src/gateway/tool-registry.js';

describe('native tool policy', () => {
  it('retains shared read policy and explicit native metadata policy', () => {
    expect(requireToolPolicy('memphis_code_read', TOOL_REGISTRY).tier).toBe(2);
    expect(requireToolPolicy('memphis_vault_list', TOOL_REGISTRY).tier).toBe(0);
  });
  it('rejects unclassified executable operations', () => {
    expect(() => requireToolPolicy('memphis_unclassified', TOOL_REGISTRY)).toThrow(/Missing/);
  });
});
