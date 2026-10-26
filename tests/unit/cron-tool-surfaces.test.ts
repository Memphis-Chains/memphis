import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NATIVE_TOOL_CONTRACTS, getToolContract } from '../../src/gateway/tool-contract.js';
import { createInProcessToolExecutor } from '../../src/gateway/tool-executor.js';
import { TOOL_REGISTRY } from '../../src/gateway/tool-registry.js';

const RUST_CATALOG = resolve('crates/memphis-operator/src/chat_tool_catalog.rs');
const RUST_EXECUTOR = resolve('crates/memphis-operator/src/chat_tool_executor.rs');

describe('the two cron surfaces', () => {
  // The native surface manages cron SCRIPT FILES in ~/memphis/crons/; the
  // gateway manages scheduled TASKS. They were both called `memphis_cron`,
  // so one name meant two tools with two vocabularies (schedule vs cron) —
  // and the model could not tell which one it was looking at.
  it('gives the script-file surface its own name', () => {
    const contract = getToolContract('memphis_cron_script');
    expect(contract).toBeDefined();
    expect(contract?.exposures).toEqual(['native']);
    expect(contract?.gatewayHidden).toBe(true);
  });

  it('keeps memphis_cron as the gateway scheduler only', () => {
    const contract = getToolContract('memphis_cron');
    expect(contract?.exposures).toEqual(['gateway']);
    expect(contract?.gatewayHidden).toBeUndefined();
  });

  it('does not advertise the script surface on the gateway', () => {
    const gatewayTools = createInProcessToolExecutor()
      .listTools()
      .map((tool) => tool.name);
    expect(gatewayTools).toContain('memphis_cron');
    expect(gatewayTools).not.toContain('memphis_cron_script');
  });

  it('uses the same word for a cron expression on both surfaces', () => {
    // The native tool took `schedule` while the gateway took `cron`. The
    // script file keeps its `# schedule:` header — that is a file format,
    // not a tool argument — but the argument is `cron` everywhere now.
    const registry = TOOL_REGISTRY.memphis_cron_script;
    expect(registry.inputSchema).toBeDefined();
    const shape = registry.inputSchema as unknown as {
      shape?: Record<string, unknown>;
    };
    expect(Object.keys(shape.shape ?? {})).toContain('cron');
    expect(Object.keys(shape.shape ?? {})).not.toContain('schedule');
  });

  it('renames the native catalog entry and its dispatcher arm together', () => {
    const catalog = readFileSync(RUST_CATALOG, 'utf8');
    const executor = readFileSync(RUST_EXECUTOR, 'utf8');
    expect(catalog).toContain('name: "memphis_cron_script"');
    expect(catalog).not.toContain('name: "memphis_cron"');
    expect(executor).toContain('"memphis_cron_script" =>');
    expect(executor).not.toContain('"memphis_cron" =>');
  });

  it('keeps one contract entry per tool name', () => {
    const names = NATIVE_TOOL_CONTRACTS.map((contract) => contract.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
