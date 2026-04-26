/**
 * Unit test: runtime executor (in-process) exposes the same tools as the
 * registry, modulo feature-flagged ones.
 *
 * Surfaced after a 2026-04-26 deep search (sprint S1): seven tools were
 * declared in `tool-registry.ts` but had no runtime handler — the LLM
 * could see them in auto-generated docs but tool calls would land
 * "tool not found". This test pins the contract that for every
 * registered, feature-flag-allowed tool there IS a runtime handler.
 */
import { describe, expect, it } from 'vitest';

import { createInProcessToolExecutor } from '../../src/gateway/tool-executor.js';
import { getToolNames } from '../../src/gateway/tool-registry.js';

describe('runtime tool executor coverage', () => {
  it('exposes every registered (non-experimental) tool as a runtime handler', () => {
    const executor = createInProcessToolExecutor();
    const runtimeNames = new Set(executor.listTools().map((t) => t.name));
    const registryNames = getToolNames();

    const missing = registryNames.filter((n) => !runtimeNames.has(n));
    expect(missing).toEqual([]);
  });

  it('exposes the seven tools wired in sprint S1', () => {
    const executor = createInProcessToolExecutor();
    const names = new Set(executor.listTools().map((t) => t.name));

    // S1 (2026-04-26) deep-search finding: these were in registry but
    // not in createRuntimeTools, which left them invisible to TUI/Telegram
    // chat surfaces (only MCP could see them). Now thin-wrapped.
    expect(names.has('memphis_config_show')).toBe(true);
    expect(names.has('memphis_config_set')).toBe(true);
    expect(names.has('memphis_config_reload')).toBe(true);
    expect(names.has('memphis_cognitive_mode_set')).toBe(true);
    expect(names.has('memphis_presence')).toBe(true);
    expect(names.has('memphis_loop_step')).toBe(true);
    expect(names.has('memphis_restart')).toBe(true);
  });

  it('exposes experimental-feature-gated tools when MEMPHIS_FEATURES flag is set', () => {
    const executor = createInProcessToolExecutor({
      rawEnv: { ...process.env, MEMPHIS_FEATURES: 'experimental-tools' },
    });
    const names = new Set(executor.listTools().map((t) => t.name));

    const flagged = getToolNames({ MEMPHIS_FEATURES: 'experimental-tools' });
    const missing = flagged.filter((n) => !names.has(n));
    expect(missing).toEqual([]);
  });
});
