import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { runCliResult } from '../helpers/cli.js';

/**
 * `memphis classify` — CLI surface over `memphis_classify`.
 *
 * The tool existed only on the MCP and native surfaces, so `memphis
 * classify --state ...` printed the help text (journal-670, 2026-10-03).
 * These tests cover the argument contract and criteria parsing WITHOUT the
 * BASAL service: a stub answers the POST, so the suite never pays the
 * 28-140 s a real decision costs on this host.
 *
 * The validation cases below are the regression net for a mutant that
 * survives reading the code: relaxing the "at least two options" guard to
 * `optionCount < 1` still returns `ok: true` for a single option, because
 * one option is a valid payload for the service — only the CLI contract
 * forbids it.
 */
const stubUrl = 'http://127.0.0.1:9/v1/systemone';

function cliEnv(): NodeJS.ProcessEnv {
  return {
    MEMPHIS_BASAL_URL: stubUrl,
    MEMPHIS_DATA_DIR: mkdtempSync(join(tmpdir(), 'memphis-cli-classify-')),
    DEFAULT_PROVIDER: 'local-fallback',
  };
}

const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('CLI classify argument contract', () => {
  it('rejects a missing --state before contacting the service', async () => {
    const result = await runCliResult(
      ['classify', '--question', 'co?', '--criteria', 'a:Alpha,b:Beta', '--json'],
      { env: cliEnv() },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('--state');
  });

  it('rejects a missing --question before contacting the service', async () => {
    const result = await runCliResult(
      ['classify', '--state', 'tekst', '--criteria', 'a:Alpha,b:Beta', '--json'],
      { env: cliEnv() },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('--question');
  });

  it('rejects a missing --criteria before contacting the service', async () => {
    const result = await runCliResult(
      ['classify', '--state', 'tekst', '--question', 'co?', '--json'],
      { env: cliEnv() },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('--criteria');
  });

  // Regression net: `optionCount < 1` is indistinguishable from `< 2`
  // unless something asserts the CLI refuses a single option.
  it('rejects a single criteria option (at least two required)', async () => {
    const result = await runCliResult(
      ['classify', '--state', 'tekst', '--question', 'co?', '--criteria', 'karta', '--json'],
      { env: cliEnv() },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('at least two criteria options');
  });

  it('rejects more than ten criteria options', async () => {
    const many = Array.from({ length: 11 }, (_, i) => `k${i}:opis ${i}`).join(',');
    const result = await runCliResult(
      ['classify', '--state', 'tekst', '--question', 'co?', '--criteria', many, '--json'],
      { env: cliEnv() },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('at most 10 options');
  });

  it('treats a bare option list as keys without descriptions', async () => {
    let captured: { questions?: { k?: { criteria?: Record<string, string> } } } = {};
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      captured = JSON.parse(String(init?.body ?? '{}')) as typeof captured;
      return new Response(
        JSON.stringify({
          ok: true,
          choice: 'karta',
          probabilities: { karta: 0.9, kredyt: 0.1 },
          confidence: 0.9,
          threshold: 0.93,
          auto: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    const result = await runCliResult(
      [
        'classify',
        '--state',
        'Karta zablokowana',
        '--question',
        'Jaki typ?',
        '--criteria',
        'karta,kredyt',
        '--json',
      ],
      { env: cliEnv() },
    );

    expect(result.status).toBe(0);
    expect(captured.questions?.k?.criteria).toEqual({ karta: 'karta', kredyt: 'kredyt' });
  });

  it('parses key:description pairs and forwards orders and threshold', async () => {
    // `threshold` is deliberately absent: the service never receives it
    // (src/mcp/tools/classify.ts builds the body without it) — it is a
    // caller-side bar applied to the returned confidence.
    let captured: {
      questions?: { k?: { criteria?: Record<string, string>; instructions?: string } };
      orders?: number;
    } = {};
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      captured = JSON.parse(String(init?.body ?? '{}')) as typeof captured;
      return new Response(
        JSON.stringify({
          ok: true,
          choice: 'karta',
          probabilities: { karta: 0.91, kredyt: 0.09 },
          confidence: 0.91,
          threshold: 0.93,
          auto: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    const result = await runCliResult(
      [
        'classify',
        '--state',
        'Karta zablokowana',
        '--question',
        'Jaki typ?',
        '--criteria',
        'karta:Reklamacje kart, kredyt:Pożyczki',
        '--orders',
        '2',
        '--threshold',
        '0.8',
        '--json',
      ],
      { env: cliEnv() },
    );

    expect(result.status).toBe(0);
    expect(captured.questions?.k?.criteria).toEqual({
      karta: 'Reklamacje kart',
      kredyt: 'Pożyczki',
    });
    expect(captured.questions?.k?.instructions).toBe('Jaki typ?');
    expect(captured.orders).toBe(2);
  });

  it('surfaces a service error instead of throwing', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 500 })) as typeof globalThis.fetch;

    const result = await runCliResult(
      [
        'classify',
        '--state',
        'tekst',
        '--question',
        'co?',
        '--criteria',
        'a:Alpha,b:Beta',
        '--json',
      ],
      { env: cliEnv() },
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; result: { ok: boolean } };
    expect(parsed.ok).toBe(true);
    expect(parsed.result.ok).toBe(false);
  });
});
