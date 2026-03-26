import { describe, expect, it } from 'vitest';

import { createInProcessToolExecutor } from '../../src/gateway/tool-executor.js';

describe('in-process tool executor', () => {
  it('exposes the same core soul/case surface as MCP', () => {
    const executor = createInProcessToolExecutor();
    const names = executor
      .listTools()
      .map((tool) => tool.name)
      .sort();

    expect(names).toContain('memphis_soul_read');
    expect(names).toContain('memphis_soul_write');
    expect(names).toContain('memphis_case_append');
    expect(names).toContain('memphis_case_query');
    expect(names).toContain('memphis_self_modify');
  });
});
