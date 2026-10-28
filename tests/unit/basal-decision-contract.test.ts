import { afterEach, expect, it, vi } from 'vitest';

import { runMemphisClassify } from '../../src/mcp/tools/classify.js';

const input = {
  state: 'synthetic public fixture',
  question: 'Which category?',
  criteria: { a: 'Alpha', b: 'Beta' },
};
const valid = () => ({
  model: 'synthetic-basal',
  answers: {
    k: { type: 'choice', choice: 'a', probabilities: { a: 0.97, b: 0.03 }, confidence: 0.97 },
  },
  usage: { latency_ms: 12 },
});
function reply(payload: unknown, status = 200) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('exposes reported model identity and treats threshold eligibility as advisory', async () => {
  reply(valid());
  expect(await runMemphisClassify(input, {})).toMatchObject({
    ok: true,
    model: 'synthetic-basal',
    auto: true,
    calibration: 'unreported',
    deferred: false,
    confidence: 0.97,
    latencyMs: 12,
  });
});

it.each([{ deferred: true }, { calibration: 'unvalidated' }])(
  'honors service abstention despite high confidence: %j',
  async (extra) => {
    const payload = valid();
    Object.assign(payload.answers.k, extra);
    reply(payload);
    expect(await runMemphisClassify(input, {})).toMatchObject({ ok: true, auto: false });
  },
);

it('refuses unknown, missing, non-normalized and contradictory probability distributions', async () => {
  const variants = [
    { probabilities: { a: 0.97 } },
    { probabilities: { a: 0.97, outside: 0.03 } },
    { probabilities: { a: 0.97, b: 0.9 } },
    { probabilities: { a: 1.2, b: -0.2 }, confidence: 1.2 },
    { probabilities: { a: '0.97', b: 0.03 } },
    { probabilities: [] },
    { confidence: null },
    { confidence: '0.97' },
    { confidence: 0.999 },
    { choice: 'outside' },
    { choice: 'b' },
    { type: 'score' },
    { deferred: 'false' },
    { calibration: 'certified-by-magic' },
  ];
  for (const change of variants) {
    const payload = valid();
    Object.assign(payload.answers.k, change);
    reply(payload);
    expect(await runMemphisClassify(input, {})).toMatchObject({
      ok: false,
      stateKind: 'service-error',
    });
  }
});

it('refuses non-finite JSON numbers and malformed top-level data', async () => {
  const bodies = [
    'null',
    '[]',
    'not JSON',
    '{"answers":{"k":{"type":"choice","choice":"a","probabilities":{"a":1e999,"b":0},"confidence":1e999}}}',
  ];
  for (const body of bodies) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    expect(await runMemphisClassify(input, {})).toMatchObject({ ok: false });
  }
});

it('validates canonical Boolean probabilities and legacy winning labels', async () => {
  reply({
    answers: {
      k: { type: 'noul', noul: 0.97, probabilities: { true: 0.97, false: 0.03 }, confidence: 0.97 },
    },
  });
  expect(await runMemphisClassify({ ...input, type: 'noul' }, {})).toMatchObject({
    ok: true,
    noul: 0.97,
  });
  reply({
    answers: {
      k: { type: 'noul', noul: 'b', probabilities: { a: 0.97, b: 0.03 }, confidence: 0.97 },
    },
  });
  expect(await runMemphisClassify({ ...input, type: 'noul' }, {})).toMatchObject({ ok: false });
});

it('checks the ordinal expected score instead of trusting an unrelated number', async () => {
  const payload = {
    answers: {
      k: { type: 'score', score: 0.25, probabilities: { '0': 0.75, '1': 0.25 }, confidence: 0.75 },
    },
  };
  reply(payload);
  expect(
    await runMemphisClassify({ ...input, type: 'score', criteria: ['Low', 'High'] }, {}),
  ).toMatchObject({
    ok: true,
    score: 0.25,
  });
  payload.answers.k.score = 0.9;
  reply(payload);
  expect(
    await runMemphisClassify({ ...input, type: 'score', criteria: ['Low', 'High'] }, {}),
  ).toMatchObject({ ok: false });
});

it('rejects invalid caller policy before making a request', async () => {
  const fetch = reply(valid());
  for (const threshold of [-1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(await runMemphisClassify({ ...input, threshold }, {})).toMatchObject({
      ok: false,
      stateKind: 'bad-request',
    });
  }
  expect(await runMemphisClassify({ ...input, criteria: ['a', 'a'] }, {})).toMatchObject({
    ok: false,
  });
  expect(fetch).not.toHaveBeenCalled();
});

it('does not echo private backend errors into the tool result', async () => {
  const sentinel = 'synthetic-private-sentinel';
  reply({ error: sentinel }, 503);
  expect(JSON.stringify(await runMemphisClassify(input, {}))).not.toContain(sentinel);
  reply({ error: sentinel });
  expect(JSON.stringify(await runMemphisClassify(input, {}))).not.toContain(sentinel);
});

it('bounds successful response bodies before decoding', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(65537))));
  expect(await runMemphisClassify(input, {})).toMatchObject({
    ok: false,
    stateKind: 'service-error',
  });
});

it('keeps the deadline active while waiting for a body after headers arrive', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal.addEventListener(
                'abort',
                () => controller.error(new DOMException('aborted', 'AbortError')),
                { once: true },
              );
            },
          }),
        ),
    ),
  );
  const pending = runMemphisClassify(input, {});
  await vi.advanceTimersByTimeAsync(300001);
  expect(await pending).toMatchObject({ ok: false, stateKind: 'timeout' });
});
