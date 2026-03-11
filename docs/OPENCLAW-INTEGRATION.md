# Memphis v5 + OpenClaw Integration Guide (Beta)

This guide connects Memphis as a memory provider for OpenClaw.

> Beta note: plugin integration is functional but still evolving. Start in local/dev mode first.

## What You Need

- Memphis v5 running locally
- OpenClaw installed
- Node.js 20+
- Plugin package: `@memphis/openclaw-plugin`

## 1) Prepare Memphis API endpoint

The plugin talks to Memphis over HTTP endpoints:
- `POST /api/journal`
- `POST /api/recall`
- `POST /api/decide`

Make sure your Memphis service is reachable (example):

```text
http://127.0.0.1:3000
```

If using MCP transport instead, you can run:

```bash
npm run -s cli -- mcp serve --transport http --port 3001
```

## 2) Install the OpenClaw plugin

Inside your OpenClaw project:

```bash
npm i @memphis/openclaw-plugin
```

## 3) Configure OpenClaw memory provider

Create or update your OpenClaw config:

```ts
import { MemphisMemoryProvider } from '@memphis/openclaw-plugin';

export default {
  plugins: {
    memory: {
      provider: MemphisMemoryProvider,
      config: {
        baseUrl: 'http://127.0.0.1:3000',
        timeoutMs: 5000,
        defaultLimit: 10,
        // Optional:
        // apiKey: process.env.MEMPHIS_API_KEY,
        // userId: 'agent-main',
        // auditLogPath: './logs/memphis-plugin-audit.log'
      },
    },
  },
};
```

## 4) Verify plugin behavior

Test expected mappings:

- `search(query)` -> `POST /api/recall`
- `save(content)` -> `POST /api/journal`
- `delete(id)` -> `POST /api/decide` (tombstone, append-only safe delete)

Suggested smoke test flow:

1. Save one memory from OpenClaw.
2. Search by related phrase.
3. Delete/tombstone a test record.
4. Confirm all requests return success.

## 5) Troubleshooting

### Plugin installed but no results

- Verify `baseUrl` points to active Memphis API.
- Check timeout (`timeoutMs`) not too low.
- Confirm Memphis has stored data.

### Connection refused

- Memphis service not running on configured host/port.
- Firewall or localhost binding mismatch.

### Slow responses

- Start with `defaultLimit: 5`.
- Reduce concurrent memory calls in OpenClaw.
- Keep Memphis and OpenClaw on same machine for beta.

## Security Recommendations (Beta)

- Keep Memphis local/private network.
- Use API key (`apiKey`) when exposed beyond localhost.
- Enable audit logging for shared/team setups.
- Do not expose memory endpoints publicly without auth.

## Optional: Local Plugin Development

If you are developing plugin from this repo directly:

```bash
cd packages/@memphis/openclaw-plugin
npm install
npm run build
npm test
```

Then link or pack it into your OpenClaw project.

---

When this is done, OpenClaw gets persistent memory + semantic retrieval through Memphis.
