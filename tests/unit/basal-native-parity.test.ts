import { readFileSync } from 'node:fs';

import { afterEach, expect, it, vi } from 'vitest';

import { runMemphisClassify, type ClassifyQuestionType } from '../../src/mcp/tools/classify.js';

const cases = JSON.parse(
  readFileSync(new URL('../fixtures/basal-native-parity.json', import.meta.url), 'utf8'),
) as Array<{
  name: string;
  type: ClassifyQuestionType;
  keys: string[];
  threshold: number;
  reply: unknown;
  ok: boolean;
  auto: boolean | null;
}>;
afterEach(() => vi.unstubAllGlobals());
it.each(cases)('shared native decision contract: $name', async (fixture) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(fixture.reply))),
  );
  const result = await runMemphisClassify(
    {
      state: 'public fixture',
      question: 'synthetic',
      criteria: Object.fromEntries(fixture.keys.map((key) => [key, key])),
      type: fixture.type,
      threshold: fixture.threshold,
    },
    {},
  );
  expect(result.ok).toBe(fixture.ok);
  if (result.ok) expect(result.auto).toBe(fixture.auto);
  expect(JSON.stringify(result)).not.toContain('private-sentinel');
});
it('discovers a fresh matching model threshold and honors explicit caller policy', async () => {
  const modelReply = {
    model: 'synthetic',
    answers: {
      k: { type: 'choice', choice: 'a', probabilities: { a: 0.95, b: 0.05 }, confidence: 0.95 },
    },
  };
  let reported = 0.9546;
  const fetch = vi.fn(
    async (_url: unknown, init?: RequestInit) =>
      new Response(
        JSON.stringify(
          init?.method === 'POST'
            ? modelReply
            : { model: 'synthetic', thresholds: { '0.01': { confidence: reported } } },
        ),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  const input = {
    state: 'public fixture',
    question: 'synthetic',
    criteria: { a: 'Alpha', b: 'Beta' },
  };
  expect(await runMemphisClassify(input, {})).toMatchObject({
    ok: true,
    threshold: 0.9546,
    auto: false,
  });
  reported = 0.94;
  expect(await runMemphisClassify(input, {})).toMatchObject({
    ok: true,
    threshold: 0.94,
    auto: true,
  });
  fetch.mockClear();
  expect(await runMemphisClassify({ ...input, threshold: 0.5 }, {})).toMatchObject({
    ok: true,
    threshold: 0.5,
    auto: true,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('maps an ordered score array to explicit ordinal request positions', async () => {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body)).questions.k.criteria).toEqual({
      '0': 'Low',
      '1': 'High',
    });
    return new Response(
      JSON.stringify({
        answers: {
          k: {
            type: 'score',
            score: 0.25,
            probabilities: { '0': 0.75, '1': 0.25 },
            confidence: 0.75,
          },
        },
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  expect(
    await runMemphisClassify(
      {
        state: 'public fixture',
        question: 'synthetic',
        criteria: ['Low', 'High'],
        type: 'score',
        threshold: 0.93,
      },
      {},
    ),
  ).toMatchObject({ ok: true, score: 0.25 });
});

it.each([
  {
    name: 'another model',
    status: 200,
    health: { model: 'other', thresholds: { '0.01': { confidence: 0.99 } } },
  },
  {
    name: 'invalid threshold',
    status: 200,
    health: { model: 'synthetic', thresholds: { '0.01': { confidence: 1.5 } } },
  },
  { name: 'private health error', status: 200, health: { error: 'private-sentinel' } },
  { name: 'unavailable health', status: 503, health: { error: 'private-sentinel' } },
])(
  'uses the advisory fallback for $name without echoing health errors',
  async ({ status, health }) => {
    const reply = {
      model: 'synthetic',
      answers: {
        k: { type: 'choice', choice: 'a', probabilities: { a: 0.95, b: 0.05 }, confidence: 0.95 },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: unknown, init?: RequestInit) =>
          new Response(JSON.stringify(init?.method === 'POST' ? reply : health), {
            status: init?.method === 'POST' ? 200 : status,
          }),
      ),
    );
    const result = await runMemphisClassify(
      { state: 'public fixture', question: 'synthetic', criteria: { a: 'Alpha', b: 'Beta' } },
      {},
    );
    expect(result).toMatchObject({ ok: true, threshold: 0.93, calibration: 'unreported' });
    expect(JSON.stringify(result)).not.toContain('private-sentinel');
  },
);
