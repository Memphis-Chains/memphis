export type EndpointAuthPolicy = {
  path: string;
  method: 'GET' | 'POST' | 'DELETE';
  requiresAuth: boolean;
};

export const apiAuthPolicy: EndpointAuthPolicy[] = [
  { method: 'GET', path: '/dashboard', requiresAuth: false },
  { method: 'GET', path: '/health', requiresAuth: false },
  { method: 'GET', path: '/api/status', requiresAuth: false },
  { method: 'GET', path: '/v1/providers/health', requiresAuth: false },
  { method: 'GET', path: '/v1/metrics', requiresAuth: true },
  { method: 'GET', path: '/v1/ops/status', requiresAuth: true },
  { method: 'GET', path: '/v1/ops/tier3/sessions', requiresAuth: true },
  { method: 'GET', path: '/v1/sessions', requiresAuth: true },
  { method: 'GET', path: '/v1/sessions/:sessionId/events', requiresAuth: true },
  { method: 'GET', path: '/v1/chat/dispatch/:workId', requiresAuth: true },
  { method: 'POST', path: '/v1/chat/dispatch', requiresAuth: true },
  { method: 'POST', path: '/v1/chat/generate', requiresAuth: true },
  { method: 'POST', path: '/api/recall', requiresAuth: true },
  { method: 'POST', path: '/api/search', requiresAuth: true },
  { method: 'POST', path: '/api/journal', requiresAuth: true },
  { method: 'POST', path: '/api/model-d/proposals', requiresAuth: true },
  { method: 'POST', path: '/v1/vault/init', requiresAuth: true },
  { method: 'POST', path: '/v1/vault/encrypt', requiresAuth: true },
  { method: 'POST', path: '/v1/vault/decrypt', requiresAuth: true },
  { method: 'GET', path: '/v1/vault/entries', requiresAuth: true },
  { method: 'POST', path: '/api/webhooks/ingest', requiresAuth: true },
  { method: 'GET', path: '/api/webhooks/events', requiresAuth: true },
  { method: 'POST', path: '/api/webhooks/retry', requiresAuth: true },
  { method: 'GET', path: '/api/federation/health', requiresAuth: false },
  { method: 'POST', path: '/api/federation/peers/register', requiresAuth: true },
  { method: 'POST', path: '/api/federation/peers/heartbeat', requiresAuth: true },
  { method: 'GET', path: '/api/federation/peers', requiresAuth: true },
  { method: 'GET', path: '/api/analytics', requiresAuth: true },
  { method: 'GET', path: '/api/tasks/status', requiresAuth: true },
  { method: 'GET', path: '/api/tasks/pending', requiresAuth: true },
  { method: 'GET', path: '/api/workers/status', requiresAuth: true },
  { method: 'POST', path: '/api/workers/register', requiresAuth: true },
  { method: 'POST', path: '/api/workers/enqueue', requiresAuth: true },
  { method: 'POST', path: '/api/workers/refresh', requiresAuth: true },
  { method: 'POST', path: '/api/workers/poll', requiresAuth: true },
  { method: 'POST', path: '/api/workers/ack', requiresAuth: true },
  { method: 'POST', path: '/api/workers/heartbeat', requiresAuth: true },
  { method: 'POST', path: '/api/workers/complete', requiresAuth: true },
  { method: 'POST', path: '/api/workers/revoke', requiresAuth: true },
  { method: 'GET', path: '/v1/config/get', requiresAuth: true },
  { method: 'POST', path: '/v1/config/set', requiresAuth: true },
  { method: 'DELETE', path: '/v1/config/delete', requiresAuth: true },
  { method: 'GET', path: '/v1/config/list', requiresAuth: true },
  { method: 'GET', path: '/v1/config/history', requiresAuth: true },
  { method: 'GET', path: '/v1/ops/config/show', requiresAuth: true },
  { method: 'POST', path: '/v1/ops/config/reload', requiresAuth: true },
  { method: 'POST', path: '/v1/ops/config/set', requiresAuth: true },
  { method: 'POST', path: '/v1/ops/restart', requiresAuth: true },
];

export function isAuthRequired(method: string, path: string): boolean {
  for (const rule of apiAuthPolicy) {
    if (rule.method !== method) continue;

    if (rule.path === path) return rule.requiresAuth;

    if (rule.path.includes(':')) {
      const pattern = '^' + rule.path.replace(/:[^/]+/g, '[^/]+') + '$';
      if (new RegExp(pattern).test(path)) {
        return rule.requiresAuth;
      }
    }
  }

  return true;
}
