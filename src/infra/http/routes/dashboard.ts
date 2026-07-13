import { getAppVersion } from '../../../config/paths.js';

type RouteReply = {
  header: (name: string, value: string) => RouteReply;
  send: (payload: unknown) => unknown;
};
type RouteApp = {
  get: (
    path: string,
    handler: (request: unknown, reply: RouteReply) => Promise<unknown>,
  ) => unknown;
};

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Memphis — System Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem; }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 1.5rem; color: #f8fafc; }
    h2 { font-size: 0.875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin: 1.5rem 0 0.75rem; }
    .card { background: #1e2330; border: 1px solid #2d3748; border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem; }
    .card-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
    .badge { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
    .badge-ok { background: #052c16; color: #4ade80; }
    .badge-warn { background: #1c1408; color: #facc15; }
    .badge-err { background: #2c0b0e; color: #f87171; }
    .badge-info { background: #0c1a2e; color: #60a5fa; }
    .row { display: flex; justify-content: space-between; align-items: center; padding: 0.25rem 0; border-bottom: 1px solid #1e2330; }
    .row:last-child { border-bottom: none; }
    .label { color: #94a3b8; font-size: 0.875rem; }
    .value { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.875rem; color: #e2e8f0; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    .error-msg { color: #f87171; font-size: 0.875rem; margin-top: 0.25rem; }
    .footer { text-align: center; color: #475569; font-size: 0.75rem; margin-top: 2rem; }
    @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="container">
    <h1>Memphis — System Status</h1>

    <h2>Runtime</h2>
    <div class="card">
      <div id="runtime-status">Loading...</div>
    </div>

    <h2>Adapters</h2>
    <div class="grid">
      <div class="card">
        <div class="card-header">
          <span class="badge badge-info">Chain</span>
        </div>
        <div id="chain-status">Loading...</div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="badge badge-info">Vault</span>
        </div>
        <div id="vault-status">Loading...</div>
      </div>
    </div>

    <h2>Providers</h2>
    <div class="card">
      <div id="providers-status">Loading...</div>
    </div>

    <div class="footer">Memphis v${getAppVersion()} &mdash; <a href="/health" style="color:#60a5fa;">/health</a> &middot; <a href="/v1/providers/health" style="color:#60a5fa;">/v1/providers/health</a> &middot; <a href="/api/status" style="color:#60a5fa;">/api/status</a></div>
  </div>
  <script>
    async function render() {
      let data;
      try {
        const r = await fetch('/api/status');
        data = await r.json();
      } catch(e) {
        document.getElementById('runtime-status').innerHTML = '<span class="badge badge-err">Error</span> <span class="error-msg">Failed to load status: ' + e.message + '</span>';
        return;
      }

      // Runtime
      const health = data.health || {};
      const healthBadge = health.status === 'healthy' ? 'badge-ok' : health.status === 'degraded' ? 'badge-warn' : 'badge-err';
      document.getElementById('runtime-status').innerHTML = \`
        <div class="row"><span class="label">Version</span><span class="value">\${data.version || 'unknown'}</span></div>
        <div class="row"><span class="label">Uptime</span><span class="value">\${typeof data.uptimeSec === 'number' ? Math.floor(data.uptimeSec / 60) + 'm ' + (data.uptimeSec % 60) + 's' : 'unknown'}</span></div>
        <div class="row"><span class="label">Status</span><span class="badge \${healthBadge}">\${health.status || 'unknown'}</span></div>
        <div class="row"><span class="label">Local Worker</span><span class="value">\${data.localWorker?.state || 'none'}</span></div>
        <div class="row"><span class="label">Scheduler</span><span class="value">\${data.scheduler?.effectiveTarget || 'local'} (cfg=\${data.scheduler?.configuredTarget || 'local'})</span></div>
      \`;

      // Chain
      const chain = data.adapters?.chain || {};
      const chainLoaded = Boolean(chain.rustBridgeLoaded ?? chain.bridgeLoaded ?? chain.loaded);
      const chainBadge = chainLoaded ? 'badge-ok' : 'badge-err';
      document.getElementById('chain-status').innerHTML = \`
        <div class="row"><span class="label">Bridge</span><span class="badge \${chainBadge}">\${chainLoaded ? 'loaded' : 'not loaded'}</span></div>
        \${chain.error ? '<div class="error-msg">' + chain.error + '</div>' : ''}
      \`;

      // Vault
      const vault = data.adapters?.vault || {};
      const vaultBadge = vault.bridgeLoaded ? 'badge-ok' : 'badge-err';
      document.getElementById('vault-status').innerHTML = \`
        <div class="row"><span class="label">Bridge</span><span class="badge \${vaultBadge}">\${vault.bridgeLoaded ? 'loaded' : 'not loaded'}</span></div>
        \${vault.error ? '<div class="error-msg">' + vault.error + '</div>' : ''}
      \`;

      // Providers
      const providers = data.providers || [];
      if (providers.length === 0) {
        document.getElementById('providers-status').innerHTML = '<span class="label">No providers configured</span>';
      } else {
        document.getElementById('providers-status').innerHTML = providers.map(p => {
          const badge = p.ok ? 'badge-ok' : 'badge-err';
          return '<div class="row"><span class="label">' + p.name + '</span><span class="badge ' + badge + '">' + (p.ok ? 'ok' : 'error') + '</span></div>';
        }).join('');
      }
    }
    render();
    setInterval(render, 30000);
  </script>
</body>
</html>`;

export function registerDashboardRoute(app: RouteApp): void {
  app.get('/dashboard', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return reply.send(DASHBOARD_HTML);
  });
}
