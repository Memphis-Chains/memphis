/**
 * Sprint 0.1 (otel adoption) — golden test for the unified instrument()
 * wrapper + local JSONL sink.
 *
 * Verifies:
 *  - classifyToolOutput handles all 5 shapes (success/error/blocked/ok-false/parse-fail)
 *  - instrument() writes one JSONL line per call with duration + status
 *  - post-attributes are merged into the recorded span attrs
 *  - thrown errors are recorded with status=error and rethrown
 *  - nested instrument calls produce ordered, independent records
 *  - MEMPHIS_TELEMETRY_LOCAL_SINK=false disables the writer
 */

import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetLocalSinkForTests,
  getSpansFilePath,
} from '../../src/infra/observability/console-exporter.js';
import {
  classifyToolOutput,
  instrument,
} from '../../src/infra/observability/instrument.js';

interface SpanLine {
  ts: string;
  name: string;
  attrs: Record<string, unknown>;
  durationMs?: number;
  status: 'ok' | 'error';
  errorMessage?: string;
}

function readSpans(dataDir: string): SpanLine[] {
  const dir = path.join(dataDir, 'telemetry');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.startsWith('spans-') && f.endsWith('.jsonl'));
  const out: SpanLine[] = [];
  for (const f of files) {
    const raw = readFileSync(path.join(dir, f), 'utf8').trim();
    if (!raw) continue;
    for (const line of raw.split('\n')) {
      out.push(JSON.parse(line));
    }
  }
  return out;
}

describe('classifyToolOutput', () => {
  it.each([
    ['{"foo":"bar"}', 'success'],
    ['{"results":[1,2,3]}', 'success'],
    ['[]', 'success'],
    ['{"error":"permission denied"}', 'error'],
    ['{"ok":false,"reason":"x"}', 'error'],
    ['{"blocked":true,"tool":"x"}', 'error'],
    ['not json text', 'unknown'],
    ['', 'unknown'],
  ])('classifies %s as %s', (input, expected) => {
    expect(classifyToolOutput(input)).toBe(expected);
  });

  it('treats blocked:false as success', () => {
    expect(classifyToolOutput('{"blocked":false}')).toBe('success');
  });

  it('treats ok:true as success', () => {
    expect(classifyToolOutput('{"ok":true}')).toBe('success');
  });
});

describe('instrument() + local JSONL sink', () => {
  let tmpDir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'memphis-otel-test-'));
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

  it('writes one JSONL line per successful instrument call', async () => {
    const result = await instrument(
      'test.span',
      { 'test.id': 'abc', count: 1 },
      async () => 42,
    );
    expect(result).toBe(42);

    const spans = readSpans(tmpDir);
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('test.span');
    expect(spans[0].status).toBe('ok');
    expect(spans[0].attrs['test.id']).toBe('abc');
    expect(spans[0].attrs.count).toBe(1);
    expect(spans[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records error status and rethrows when fn throws', async () => {
    const err = new Error('boom');
    await expect(
      instrument('failing.span', { tag: 'x' }, async () => {
        throw err;
      }),
    ).rejects.toThrow('boom');

    const spans = readSpans(tmpDir);
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('failing.span');
    expect(spans[0].status).toBe('error');
    expect(spans[0].errorMessage).toBe('boom');
  });

  it('merges post-attributes into the recorded span', async () => {
    await instrument(
      'tool.call',
      { 'tool.name': 'memphis_journal' },
      async () => '{"ok":true,"index":42}',
      {
        postAttributes: (output) => ({
          'tool.output.shape': classifyToolOutput(output as string),
          'tool.output.length': (output as string).length,
        }),
      },
    );

    const spans = readSpans(tmpDir);
    expect(spans).toHaveLength(1);
    expect(spans[0].attrs['tool.name']).toBe('memphis_journal');
    expect(spans[0].attrs['tool.output.shape']).toBe('success');
    expect(spans[0].attrs['tool.output.length']).toBe(22);
  });

  it('captures output.shape=error and can mark semantic error results as failed spans', async () => {
    await instrument(
      'tool.call',
      { 'tool.name': 'memphis_exec' },
      async () => '{"error":"PERMISSION_DENIED"}',
      {
        postAttributes: (output) => ({
          'tool.output.shape': classifyToolOutput(output as string),
        }),
        statusFromResult: (output) =>
          classifyToolOutput(output as string) === 'error' ? 'error' : undefined,
        errorMessageFromResult: (output) => output as string,
      },
    );

    const spans = readSpans(tmpDir);
    expect(spans[0].attrs['tool.output.shape']).toBe('error');
    expect(spans[0].status).toBe('error');
    expect(spans[0].errorMessage).toBe('{"error":"PERMISSION_DENIED"}');
  });

  it('keeps successful span status by default for non-throwing semantic error payloads', async () => {
    await instrument(
      'tool.call',
      { 'tool.name': 'memphis_exec' },
      async () => '{"error":"PERMISSION_DENIED"}',
      {
        postAttributes: (output) => ({
          'tool.output.shape': classifyToolOutput(output as string),
        }),
      },
    );

    const spans = readSpans(tmpDir);
    expect(spans[0].attrs['tool.output.shape']).toBe('error');
    expect(spans[0].status).toBe('ok');
  });

  it('records nested spans in completion order', async () => {
    await instrument('outer.turn', { surface: 'test' }, async () => {
      await instrument('inner.tool', { name: 'a' }, async () => 'ok-a');
      await instrument('inner.tool', { name: 'b' }, async () => 'ok-b');
      return 'done';
    });

    const spans = readSpans(tmpDir);
    expect(spans).toHaveLength(3);
    expect(spans[0].name).toBe('inner.tool');
    expect(spans[0].attrs.name).toBe('a');
    expect(spans[1].name).toBe('inner.tool');
    expect(spans[1].attrs.name).toBe('b');
    expect(spans[2].name).toBe('outer.turn');
  });

  it('writes to file at getSpansFilePath(rawEnv)', async () => {
    await instrument('path.check', {}, async () => 1);
    const expectedPath = getSpansFilePath(process.env);
    expect(existsSync(expectedPath)).toBe(true);
  });

  it('respects MEMPHIS_TELEMETRY_LOCAL_SINK=false', async () => {
    process.env.MEMPHIS_TELEMETRY_LOCAL_SINK = 'false';
    await instrument('disabled.span', {}, async () => 1);
    expect(readSpans(tmpDir)).toHaveLength(0);
  });

  it('respects MEMPHIS_TELEMETRY_LOCAL_SINK=0', async () => {
    process.env.MEMPHIS_TELEMETRY_LOCAL_SINK = '0';
    await instrument('disabled.span', {}, async () => 1);
    expect(readSpans(tmpDir)).toHaveLength(0);
  });

  it('hierarchy golden test — turn → provider → tool.call', async () => {
    await instrument('turn.dispatch', { surface: 'telegram' }, async () => {
      await instrument(
        'provider.completion',
        { 'provider.name': 'anthropic', 'provider.model': 'claude-opus-4-7' },
        async () => 'response',
      );
      await instrument(
        'tool.call',
        { 'tool.name': 'memphis_journal' },
        async () => '{"ok":true}',
        {
          postAttributes: (o) => ({ 'tool.output.shape': classifyToolOutput(o as string) }),
        },
      );
      await instrument(
        'tool.call',
        { 'tool.name': 'memphis_exec' },
        async () => '{"error":"denied"}',
        {
          postAttributes: (o) => ({ 'tool.output.shape': classifyToolOutput(o as string) }),
        },
      );
      return 'turn-result';
    });

    const spans = readSpans(tmpDir);
    const counts = spans.reduce<Record<string, number>>((acc, s) => {
      acc[s.name] = (acc[s.name] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts['turn.dispatch']).toBe(1);
    expect(counts['provider.completion']).toBe(1);
    expect(counts['tool.call']).toBe(2);

    const toolSpans = spans.filter((s) => s.name === 'tool.call');
    const shapes = toolSpans.map((s) => s.attrs['tool.output.shape']);
    expect(shapes).toContain('success');
    expect(shapes).toContain('error');
  });
});
