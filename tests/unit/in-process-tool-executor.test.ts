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
    expect(names).toContain('memphis_deploy');
    expect(names).toContain('memphis_self_modify');
    expect(names).toContain('memphis_search');
  });

  it('publishes runtime tool metadata for batching decisions', () => {
    const executor = createInProcessToolExecutor();
    const toolMap = new Map(executor.listTools().map((tool) => [tool.name, tool]));

    expect(toolMap.get('memphis_recall')).toMatchObject({
      isConcurrencySafe: true,
      isReadOnly: true,
    });
    expect(toolMap.get('memphis_search')).toMatchObject({
      isConcurrencySafe: true,
      isReadOnly: true,
    });
    expect(toolMap.get('memphis_exec')).toMatchObject({
      isConcurrencySafe: false,
      isDestructive: true,
    });
    expect(executor.maxParallel).toBe(4);
  });
});
