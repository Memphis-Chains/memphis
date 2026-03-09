import http from 'node:http';
import nodeProcess from 'node:process';

const PORT = Number(nodeProcess.env.OLLAMA_BRIDGE_PORT || 11435);
const OLLAMA_BASE = nodeProcess.env.OLLAMA_BASE || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = nodeProcess.env.OLLAMA_MODEL || 'qwen3.5:2b';
const API_KEY = nodeProcess.env.OLLAMA_BRIDGE_API_KEY || 'local-ollama';

function send(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function authOk(req) {
  const h = req.headers.authorization || '';
  return h === `Bearer ${API_KEY}`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/health' && req.method === 'GET') {
      const r = await globalThis.fetch(`${OLLAMA_BASE}/api/tags`);
      if (!r.ok) return send(res, 503, { ok: false, error: `ollama_http_${r.status}` });
      return send(res, 200, { ok: true });
    }

    if (req.url === '/v1/generate' && req.method === 'POST') {
      if (!authOk(req)) return send(res, 401, { error: 'unauthorized' });
      const raw = await collectBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const model = body.model || DEFAULT_MODEL;

      const ollamaRes = await globalThis.fetch(`${OLLAMA_BASE}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: body.input || '',
          stream: false,
          think: false,
          options: {
            temperature: body.options?.temperature,
            num_predict: body.options?.maxTokens,
          },
        }),
      });

      if (!ollamaRes.ok) {
        return send(res, 503, { error: `ollama_generate_failed_${ollamaRes.status}` });
      }

      const out = await ollamaRes.json();
      return send(res, 200, {
        output: out.response || '',
        model: out.model || model,
      });
    }

    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    return send(res, 500, { error: e instanceof Error ? e.message : 'internal_error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  globalThis.console.log(`ollama-compat-bridge listening on 127.0.0.1:${PORT}, model=${DEFAULT_MODEL}`);
});
