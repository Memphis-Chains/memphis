/**
 * Sprint 0.2 — confabulation detector unit tests.
 *
 * Three rules covered with positive + negative fixtures:
 *   A. error tool → success-claim
 *   B. phantom config key (ALLOW_EXEC=true and friends)
 *   C. empty list → enumeration
 *
 * Plus 7-day rolling counter integration: writes events through
 * recordConfabulationEvent → countConfabulationEventsInWindow returns
 * the expected count.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  countConfabulationEventsInWindow,
  detectConfabulation,
  recordConfabulationEvent,
  type ToolResultSnapshot,
} from '../../src/infra/observability/confabulation-detector.js';
import {
  __resetLocalSinkForTests,
  recordLocalSpan,
} from '../../src/infra/observability/console-exporter.js';

describe('detectConfabulation — Rule A (error → success claim)', () => {
  it('flags PL "udało się" claim after a tool error', () => {
    const tools: ToolResultSnapshot[] = [
      { name: 'memphis_exec', output: '{"error":"PERMISSION_DENIED"}' },
    ];
    const event = detectConfabulation(tools, 'OK, udało się odblokować exec.');
    expect(event).not.toBeNull();
    expect(event!.rule).toBe('A');
    expect(event!.toolName).toBe('memphis_exec');
    expect(event!.evidence.toLowerCase()).toContain('udało się');
  });

  it('flags EN "done" claim after a tool error', () => {
    const tools: ToolResultSnapshot[] = [
      { name: 'memphis_git', output: '{"ok":false,"reason":"nothing staged"}' },
    ];
    const event = detectConfabulation(tools, 'Pushed the change. Done!');
    expect(event!.rule).toBe('A');
  });

  it('flags blocked tool + ✅ checkmark claim', () => {
    const tools: ToolResultSnapshot[] = [
      { name: 'memphis_fs_write', output: '{"blocked":true,"tool":"memphis_fs_write"}' },
    ];
    const event = detectConfabulation(tools, '✅ OK, file saved.');
    expect(event!.rule).toBe('A');
  });

  it('does NOT flag when tool succeeds and claim is success', () => {
    const tools: ToolResultSnapshot[] = [
      { name: 'memphis_journal', output: '{"ok":true,"index":42}' },
    ];
    const event = detectConfabulation(tools, 'Saved successfully.');
    expect(event).toBeNull();
  });

  it('does NOT flag when tool errors but claim is honest', () => {
    const tools: ToolResultSnapshot[] = [
      { name: 'memphis_exec', output: '{"error":"PERMISSION_DENIED"}' },
    ];
    const event = detectConfabulation(
      tools,
      'I could not run that — runtime returned PERMISSION_DENIED.',
    );
    expect(event).toBeNull();
  });
});

describe('detectConfabulation — Rule B (phantom config keys)', () => {
  it('flags ALLOW_EXEC=true (the 2026-04-27 transcript fabrication)', () => {
    const event = detectConfabulation(
      [],
      'To unblock exec, set ALLOW_EXEC=true in your env.',
    );
    expect(event!.rule).toBe('B');
    expect(event!.evidence).toMatch(/ALLOW_EXEC\s*=\s*true/i);
  });

  it('flags ALLOW_GIT=true and ALLOW_CODE_READ=true', () => {
    expect(detectConfabulation([], 'Try ALLOW_GIT=true.')!.rule).toBe('B');
    expect(detectConfabulation([], 'Set ALLOW_CODE_READ=true.')!.rule).toBe('B');
  });

  it('flags MEMPHIS_BYPASS_AUTH=true generic pattern', () => {
    const event = detectConfabulation(
      [],
      'Use MEMPHIS_BYPASS_AUTH=true if you really need to skip the gate.',
    );
    expect(event!.rule).toBe('B');
  });

  it('does NOT flag legitimate references to MEMPHIS_OTEL_ENDPOINT', () => {
    const event = detectConfabulation(
      [],
      'Set MEMPHIS_OTEL_ENDPOINT=http://localhost:4318/v1/traces to enable tracing.',
    );
    expect(event).toBeNull();
  });
});

describe('detectConfabulation — Rule C (empty list → enumeration)', () => {
  it('flags enumeration after empty array tool output', () => {
    const tools: ToolResultSnapshot[] = [
      { name: 'memphis_recall', output: '[]' },
    ];
    const claim =
      'Found relevant memories:\n1. Note about Watra\n2. Decision from April\n3. Reflection on Q1';
    const event = detectConfabulation(tools, claim);
    expect(event!.rule).toBe('C');
    expect(event!.toolName).toBe('memphis_recall');
  });

  it('flags bullet enumeration after empty {results:[]} tool output', () => {
    const tools: ToolResultSnapshot[] = [
      { name: 'memphis_search', output: '{"results":[]}' },
    ];
    const claim = 'Top hits:\n- alpha\n- beta\n- gamma';
    const event = detectConfabulation(tools, claim);
    expect(event!.rule).toBe('C');
  });

  it('flags enumeration after {count:0}', () => {
    const tools: ToolResultSnapshot[] = [
      { name: 'memphis_chain_query', output: '{"count":0,"matches":[]}' },
    ];
    const claim = 'Matches:\n- one\n- two\n- three';
    expect(detectConfabulation(tools, claim)!.rule).toBe('C');
  });

  it('does NOT flag when empty list and claim mentions no items', () => {
    const tools: ToolResultSnapshot[] = [
      { name: 'memphis_recall', output: '[]' },
    ];
    const event = detectConfabulation(tools, 'No memories found for that query.');
    expect(event).toBeNull();
  });

  it('does NOT flag enumeration when tool returned a non-empty list', () => {
    const tools: ToolResultSnapshot[] = [
      { name: 'memphis_recall', output: '[{"content":"x","score":1}]' },
    ];
    const claim = 'Found:\n1. x\n2. (nothing else)';
    expect(detectConfabulation(tools, claim)).toBeNull();
  });
});

describe('detectConfabulation — composition', () => {
  it('returns null on empty model claim', () => {
    expect(detectConfabulation([], '')).toBeNull();
  });

  it('returns first-rule match (A wins over C when both apply)', () => {
    const tools: ToolResultSnapshot[] = [
      { name: 'memphis_recall', output: '{"error":"db unreachable"}' },
    ];
    const claim = 'Done. Found:\n1. a\n2. b';
    expect(detectConfabulation(tools, claim)!.rule).toBe('A');
  });
});

describe('countConfabulationEventsInWindow — 7d rolling counter', () => {
  let tmpDir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'memphis-confab-test-'));
    process.env.MEMPHIS_DATA_DIR = tmpDir;
    delete process.env.MEMPHIS_OTEL_ENDPOINT;
    delete process.env.MEMPHIS_TELEMETRY_LOCAL_SINK;
    __resetLocalSinkForTests();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    __resetLocalSinkForTests();
  });

  it('returns 0 when no telemetry dir', () => {
    expect(countConfabulationEventsInWindow()).toBe(0);
  });

  it('returns count of recorded events', () => {
    recordConfabulationEvent({ rule: 'A', evidence: 'udało się', toolName: 'memphis_exec' });
    recordConfabulationEvent({ rule: 'B', evidence: 'ALLOW_EXEC=true' });
    recordConfabulationEvent({ rule: 'C', evidence: 'enum after empty', toolName: 'memphis_recall' });

    expect(countConfabulationEventsInWindow()).toBe(3);
  });

  it('does not count regular spans (only confabulation.event)', () => {
    recordConfabulationEvent({ rule: 'A', evidence: 'x', toolName: 't' });
    // Append non-confab spans to verify the counter filters by name.
    recordLocalSpan({ name: 'turn.dispatch', attrs: { surface: 'test' }, status: 'ok' });
    recordLocalSpan({ name: 'tool.call', attrs: { 'tool.name': 'x' }, status: 'ok' });
    expect(countConfabulationEventsInWindow()).toBe(1);
  });

  it('respects the window — events older than windowMs excluded', () => {
    // Wiring W5 test fix: previous version used a fixedNow of
    // 2026-04-28T12:00:00Z, which made the assertion time-dependent
    // — once real CI clock crossed that timestamp, the recorded
    // event's Date.now() was greater than the cutoff and the test
    // started flapping (verified PR #337 CI failure post-2026-04-28
    // 12:00 UTC). Use a far-future fixedNow so cutoff ≫ real now is
    // guaranteed forever and the assertion is deterministic.
    recordConfabulationEvent({ rule: 'A', evidence: 'x', toolName: 't' });
    const fixedFuture = new Date('2099-01-01T00:00:00Z');
    // windowMs = 0 → cutoff = fixedFuture; recorded event ts = now ≪
    // 2099 → tsMs < cutoffMs → excluded → count must be 0.
    expect(countConfabulationEventsInWindow(0, process.env, fixedFuture)).toBe(0);
  });
});
