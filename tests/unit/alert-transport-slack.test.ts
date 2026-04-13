import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createConfiguredAlertSender } from '../../src/infra/logging/alert-transport.js';

function mockFetch(ok: boolean, status = 200): typeof fetch {
  return vi.fn(async () =>
    Promise.resolve({
      ok,
      status,
    } as Response),
  ) as unknown as typeof fetch;
}

describe('alert-transport — Slack webhook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('posts to MEMPHIS_ALERT_SLACK_WEBHOOK with a structured text block', async () => {
    const fetchFn = mockFetch(true);
    const sender = createConfiguredAlertSender(
      {
        MEMPHIS_ALERT_SLACK_WEBHOOK: 'https://hooks.slack.example/services/abc',
        MEMPHIS_ALERT_SOURCE: 'memphis-test',
      } as NodeJS.ProcessEnv,
      { fetchFn },
    );
    await sender({
      severity: 'critical',
      message: 'provider cascade degraded',
      details: { provider: 'anthropic', reason: 'rate-limit' },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as { body: string };
    expect(url).toBe('https://hooks.slack.example/services/abc');
    const body = JSON.parse(init.body) as { text: string };
    expect(body.text).toMatch(/CRITICAL/);
    expect(body.text).toMatch(/memphis-test/);
    expect(body.text).toContain('provider cascade degraded');
    expect(body.text).toContain('provider: anthropic');
  });

  it('throws when the slack webhook returns non-ok', async () => {
    const fetchFn = mockFetch(false, 500);
    const sender = createConfiguredAlertSender(
      {
        MEMPHIS_ALERT_SLACK_WEBHOOK: 'https://hooks.slack.example/x',
      } as NodeJS.ProcessEnv,
      { fetchFn },
    );
    await expect(
      sender({ severity: 'high', message: 'x' }),
    ).rejects.toThrow(/all alert transports failed/);
  });
});

describe('alert-transport — generic webhook', () => {
  it('posts a normalized JSON payload to MEMPHIS_ALERT_WEBHOOK_URL', async () => {
    const fetchFn = mockFetch(true);
    const sender = createConfiguredAlertSender(
      {
        MEMPHIS_ALERT_WEBHOOK_URL: 'https://alerts.internal.example/hook',
      } as NodeJS.ProcessEnv,
      { fetchFn },
    );
    await sender({
      id: 'alert-7',
      severity: 'medium',
      message: 'chain rotation lagging',
      details: { chain: 'journal' },
    });
    const call = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const init = call[1] as { body: string };
    const body = JSON.parse(init.body) as {
      id: string;
      severity: string;
      message: string;
      details: Record<string, unknown>;
    };
    expect(body.id).toBe('alert-7');
    expect(body.severity).toBe('medium');
    expect(body.message).toBe('chain rotation lagging');
    expect(body.details.chain).toBe('journal');
  });
});

describe('alert-transport — fan-out semantics', () => {
  it('succeeds when one transport works and another fails', async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('slack')) {
        return { ok: false, status: 500 } as Response;
      }
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const sender = createConfiguredAlertSender(
      {
        MEMPHIS_ALERT_SLACK_WEBHOOK: 'https://slack.example/x',
        MEMPHIS_ALERT_WEBHOOK_URL: 'https://webhook.example/x',
      } as NodeJS.ProcessEnv,
      { fetchFn },
    );
    await expect(sender({ severity: 'high', message: 'x' })).resolves.toBeUndefined();
    expect(calls.length).toBe(2);
  });

  it('throws only when every configured transport fails', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 } as Response)) as unknown as typeof fetch;
    const sender = createConfiguredAlertSender(
      {
        MEMPHIS_ALERT_SLACK_WEBHOOK: 'https://slack.example/x',
        MEMPHIS_ALERT_WEBHOOK_URL: 'https://webhook.example/x',
      } as NodeJS.ProcessEnv,
      { fetchFn },
    );
    await expect(sender({ severity: 'high', message: 'x' })).rejects.toThrow(
      /all alert transports failed/,
    );
  });
});
