export interface AlertLike {
  id?: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  details?: Record<string, unknown>;
}

export interface AlertTransportOptions {
  fetchFn?: typeof fetch;
}

type AlertSender = (alert: AlertLike) => Promise<void>;

function severityToPagerDuty(alertSeverity: AlertLike['severity']): string {
  if (alertSeverity === 'critical') return 'critical';
  if (alertSeverity === 'high') return 'error';
  if (alertSeverity === 'medium') return 'warning';
  return 'info';
}

function severityToOpsGenie(alertSeverity: AlertLike['severity']): string {
  if (alertSeverity === 'critical') return 'P1';
  if (alertSeverity === 'high') return 'P2';
  if (alertSeverity === 'medium') return 'P3';
  return 'P4';
}

function source(rawEnv: NodeJS.ProcessEnv): string {
  return rawEnv.MEMPHIS_ALERT_SOURCE?.trim() || 'memphisos';
}

function parseTimeoutMs(rawEnv: NodeJS.ProcessEnv): number {
  const raw = rawEnv.MEMPHIS_ALERT_HTTP_TIMEOUT_MS?.trim();
  if (!raw) return 3000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 100 || parsed > 60_000) return 3000;
  return parsed;
}

function withTimeout(timeoutMs: number): AbortSignal {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), timeoutMs).unref?.();
  return ctrl.signal;
}

function pagerDutySender(
  routingKey: string,
  endpoint: string,
  rawEnv: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
): AlertSender {
  return async (alert: AlertLike) => {
    const payload = {
      routing_key: routingKey,
      event_action: 'trigger',
      dedup_key: alert.id ?? undefined,
      payload: {
        summary: alert.message,
        source: source(rawEnv),
        severity: severityToPagerDuty(alert.severity),
        custom_details: alert.details ?? {},
      },
    };
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: withTimeout(parseTimeoutMs(rawEnv)),
    });
    if (!res.ok) {
      throw new Error(`pagerduty transport failed status=${res.status}`);
    }
  };
}

function opsGenieSender(
  apiKey: string,
  endpoint: string,
  rawEnv: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
): AlertSender {
  return async (alert: AlertLike) => {
    const payload = {
      message: alert.message,
      source: source(rawEnv),
      alias: alert.id ?? undefined,
      priority: severityToOpsGenie(alert.severity),
      details: alert.details ?? {},
    };
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        authorization: `GenieKey ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: withTimeout(parseTimeoutMs(rawEnv)),
    });
    if (!res.ok) {
      throw new Error(`opsgenie transport failed status=${res.status}`);
    }
  };
}

function slackSender(
  webhookUrl: string,
  rawEnv: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
): AlertSender {
  return async (alert: AlertLike) => {
    const severityEmoji = {
      critical: ':rotating_light:',
      high: ':warning:',
      medium: ':bell:',
      low: ':information_source:',
    }[alert.severity];
    const detailLines = alert.details
      ? Object.entries(alert.details).map(
          ([k, v]) => `• ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
        )
      : [];
    const text = [
      `${severityEmoji} *${alert.severity.toUpperCase()}* [${source(rawEnv)}]`,
      alert.message,
      ...(detailLines.length > 0 ? ['', ...detailLines] : []),
    ].join('\n');
    const res = await fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: withTimeout(parseTimeoutMs(rawEnv)),
    });
    if (!res.ok) {
      throw new Error(`slack transport failed status=${res.status}`);
    }
  };
}

function genericWebhookSender(
  webhookUrl: string,
  rawEnv: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
): AlertSender {
  return async (alert: AlertLike) => {
    const payload = {
      id: alert.id ?? null,
      severity: alert.severity,
      message: alert.message,
      source: source(rawEnv),
      timestamp: new Date().toISOString(),
      details: alert.details ?? {},
    };
    const res = await fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: withTimeout(parseTimeoutMs(rawEnv)),
    });
    if (!res.ok) {
      throw new Error(`webhook transport failed status=${res.status}`);
    }
  };
}

export function createConfiguredAlertSender(
  rawEnv: NodeJS.ProcessEnv = process.env,
  options: AlertTransportOptions = {},
): AlertSender {
  const fetchFn = options.fetchFn ?? fetch;
  const senders: AlertSender[] = [];

  const pagerDutyKey = rawEnv.MEMPHIS_ALERT_PAGERDUTY_ROUTING_KEY?.trim();
  if (pagerDutyKey) {
    const endpoint =
      rawEnv.MEMPHIS_ALERT_PAGERDUTY_ENDPOINT?.trim() || 'https://events.pagerduty.com/v2/enqueue';
    senders.push(pagerDutySender(pagerDutyKey, endpoint, rawEnv, fetchFn));
  }

  const opsGenieKey = rawEnv.MEMPHIS_ALERT_OPSGENIE_API_KEY?.trim();
  if (opsGenieKey) {
    const endpoint =
      rawEnv.MEMPHIS_ALERT_OPSGENIE_ENDPOINT?.trim() || 'https://api.opsgenie.com/v2/alerts';
    senders.push(opsGenieSender(opsGenieKey, endpoint, rawEnv, fetchFn));
  }

  const slackWebhook = rawEnv.MEMPHIS_ALERT_SLACK_WEBHOOK?.trim();
  if (slackWebhook) {
    senders.push(slackSender(slackWebhook, rawEnv, fetchFn));
  }

  const genericWebhook = rawEnv.MEMPHIS_ALERT_WEBHOOK_URL?.trim();
  if (genericWebhook) {
    senders.push(genericWebhookSender(genericWebhook, rawEnv, fetchFn));
  }

  if (senders.length === 0) {
    return async () => {};
  }

  // Fan out to every configured transport in parallel. The alert succeeds as
  // long as at least one transport delivers; we surface a comprehensive error
  // only when *all* transports fail. This preserves existing pagerduty ↔
  // opsgenie behavior (they're both paging channels) while letting slack +
  // generic webhooks receive every alert in addition.
  return async (alert: AlertLike) => {
    const results = await Promise.allSettled(senders.map((sender) => sender(alert)));
    const failures = results
      .map((result, index) =>
        result.status === 'rejected'
          ? `transport[${index}]: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
          : null,
      )
      .filter((s): s is string => s !== null);
    const successes = results.length - failures.length;
    if (successes === 0) {
      throw new Error(`all alert transports failed: ${failures.join('; ')}`);
    }
  };
}
