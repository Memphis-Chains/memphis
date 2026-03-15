import { describe, expect, it } from 'vitest';

import { createConfiguredAlertSender } from '../../src/infra/logging/alert-transport.js';

describe('alert transport', () => {
  it('sends PagerDuty event when configured', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const sender = createConfiguredAlertSender(
      {
        MEMPHIS_ALERT_PAGERDUTY_ROUTING_KEY: 'pd-key',
        MEMPHIS_ALERT_PAGERDUTY_ENDPOINT: 'https://pagerduty.example/v2/enqueue',
      } as NodeJS.ProcessEnv,
      {
        fetchFn: async (input, init) => {
          calls.push({
            url: String(input),
            body: String(init?.body ?? ''),
          });
          return new Response(null, { status: 202 });
        },
      },
    );

    await sender({
      id: 'SecurityDegraded',
      severity: 'critical',
      message: 'security hardening degraded',
      details: { guard: 'safe_mode_no_egress' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://pagerduty.example/v2/enqueue');
    expect(calls[0]?.body).toContain('"routing_key":"pd-key"');
    expect(calls[0]?.body).toContain('"severity":"critical"');
  });

  it('falls through providers and throws if all transports fail', async () => {
    const calls: string[] = [];
    const sender = createConfiguredAlertSender(
      {
        MEMPHIS_ALERT_PAGERDUTY_ROUTING_KEY: 'pd-key',
        MEMPHIS_ALERT_OPSGENIE_API_KEY: 'og-key',
        MEMPHIS_ALERT_PAGERDUTY_ENDPOINT: 'https://pagerduty.example/v2/enqueue',
        MEMPHIS_ALERT_OPSGENIE_ENDPOINT: 'https://opsgenie.example/v2/alerts',
      } as NodeJS.ProcessEnv,
      {
        fetchFn: async (input) => {
          calls.push(String(input));
          return new Response('failed', { status: 503 });
        },
      },
    );

    await expect(
      sender({
        id: 'StaleRevocationCache',
        severity: 'high',
        message: 'revocation cache stale',
      }),
    ).rejects.toThrow(/all alert transports failed/);

    expect(calls).toEqual([
      'https://pagerduty.example/v2/enqueue',
      'https://opsgenie.example/v2/alerts',
    ]);
  });
});
