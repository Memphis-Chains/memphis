import { describe, expect, it } from 'vitest';

import { runMemphisLoopStep } from '../../src/mcp/tools/loop-step.js';

describe('MCP tool: memphis_loop_step', () => {
  const freshState = () => ({
    steps: 0,
    tool_calls: 0,
    wait_ms: 0,
    errors: 0,
    completed: false,
    halt_reason: null,
  });

  const defaultLimits = {
    max_steps: 32,
    max_tool_calls: 16,
    max_wait_ms: 120_000,
    max_errors: 4,
  };

  it('applies a tool_call action', () => {
    const result = runMemphisLoopStep({
      state: freshState(),
      action: { type: 'tool_call', data: { tool: 'memphis_recall' } },
    });

    expect(result.applied).toBe(true);
    expect(result.state.steps).toBe(1);
    expect(result.state.tool_calls).toBe(1);
  });

  it('applies a complete action', () => {
    const result = runMemphisLoopStep({
      state: freshState(),
      action: { type: 'complete', data: { summary: 'done' } },
    });

    expect(result.applied).toBe(true);
    expect(result.state.completed).toBe(true);
    expect(result.state.steps).toBe(1);
  });

  it('applies a wait action', () => {
    const result = runMemphisLoopStep({
      state: freshState(),
      action: { type: 'wait', data: { duration_ms: 5000 } },
    });

    expect(result.applied).toBe(true);
    expect(result.state.wait_ms).toBe(5000);
  });

  it('tracks errors', () => {
    const result = runMemphisLoopStep({
      state: freshState(),
      action: { type: 'error', data: { recoverable: true, message: 'timeout' } },
    });

    expect(result.applied).toBe(true);
    expect(result.state.errors).toBe(1);
    expect(result.state.completed).toBe(false);
  });

  it('marks non-recoverable errors as completed', () => {
    const result = runMemphisLoopStep({
      state: freshState(),
      action: { type: 'error', data: { recoverable: false, message: 'fatal' } },
    });

    expect(result.applied).toBe(true);
    expect(result.state.completed).toBe(true);
    expect(result.state.halt_reason).toBe('non_recoverable_error');
  });

  it('enforces max_steps', () => {
    const result = runMemphisLoopStep({
      state: { ...freshState(), steps: 32 },
      action: { type: 'tool_call', data: { tool: 'test' } },
      limits: defaultLimits,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toContain('max_steps');
  });

  it('enforces max_tool_calls', () => {
    const result = runMemphisLoopStep({
      state: { ...freshState(), steps: 5, tool_calls: 16 },
      action: { type: 'tool_call', data: { tool: 'test' } },
      limits: defaultLimits,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toContain('max_tool_calls');
  });

  it('enforces max_wait_ms', () => {
    const result = runMemphisLoopStep({
      state: { ...freshState(), wait_ms: 119_000 },
      action: { type: 'wait', data: { duration_ms: 2000 } },
      limits: defaultLimits,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toContain('max_wait');
  });

  it('enforces max_errors', () => {
    const result = runMemphisLoopStep({
      state: { ...freshState(), steps: 3, errors: 4 },
      action: { type: 'error', data: { recoverable: true, message: 'fail' } },
      limits: defaultLimits,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toContain('max_errors');
  });

  it('rejects steps on already-halted state', () => {
    const result = runMemphisLoopStep({
      state: { ...freshState(), completed: true, halt_reason: 'already_done' },
      action: { type: 'tool_call', data: { tool: 'test' } },
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toContain('halted');
  });

  it('respects custom limits', () => {
    const result = runMemphisLoopStep({
      state: { ...freshState(), steps: 5, tool_calls: 3 },
      action: { type: 'tool_call', data: { tool: 'test' } },
      limits: { max_steps: 100, max_tool_calls: 3, max_wait_ms: 60_000, max_errors: 2 },
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toContain('max_tool_calls');
  });
});
