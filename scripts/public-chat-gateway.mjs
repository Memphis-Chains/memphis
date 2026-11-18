#!/usr/bin/env node
// Public inference runs on local Ollama. This entry point has no operator runtime, tools or vault.
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { fileURLToPath, URL } from 'node:url';

const model = process.env.PUBLIC_CHAT_MODEL || 'qwen2.5-coder:3b';
const ollama = 'http://127.0.0.1:11434';
const hour = 3_600_000;
const maxBody = 48 * 1024;
const maxMessage = 2000;
const pages = new Map([
  ['/chat/', ['index.html', 'text/html; charset=utf-8']],
  ['/chat/chat.js', ['chat.js', 'text/javascript; charset=utf-8']],
  ['/chat/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['../favicon.svg', 'image/svg+xml']],
]);
const systemPrompt = 'Jesteś Memphis, polskojęzycznym asystentem. Odpowiadaj po polsku, krótko i jasno. '
  + 'Możesz rozmawiać i wyjaśniać. Jeśli czegoś nie wiesz, powiedz to. Nie proś o dane prywatne.';

function send(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...headers,
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBody) return { status: 413 };
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const history = body?.history === undefined ? [] : body.history;
    if (!message || message.length > maxMessage || !Array.isArray(history) || history.length > 4
      || history.length % 2 !== 0) return { status: 400 };
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const [i, turn] of history.entries()) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      if (turn?.role !== role || typeof turn.content !== 'string' || !turn.content.trim()
        || turn.content.length > maxMessage) return { status: 400 };
      messages.push({ role, content: turn.content });
    }
    messages.push({ role: 'user', content: message });
    const sessionId = typeof body.sessionId === 'string' && /^sess_[a-zA-Z0-9_]{1,40}$/.test(body.sessionId)
      ? body.sessionId : 'sess_' + randomUUID().replaceAll('-', '');
    return { messages, sessionId };
  } catch {
    return { status: 400 };
  }
}

export function createPublicChatServer({ request = fetch, trustProxy = false } = {}) {
  const clients = new Map();
  let active = 0;
  let nextCleanup = 0;
  let readiness = null;
  let checkedAt = 0;

  async function isReady() {
    if (!readiness || Date.now() - checkedAt > 5000) {
      checkedAt = Date.now();
      readiness = (async () => {
        const r = await request(ollama + '/api/tags', { redirect: 'error', signal: globalThis.AbortSignal.timeout(3000) });
        if (!r.ok) return false;
        const tags = await r.json();
        return tags.models?.some(m => m.name === model || m.name === model + ':latest') === true;
      })().catch(() => false);
    }
    return readiness;
  }

  function allowance(ip) {
    const now = Date.now();
    if (now >= nextCleanup) {
      for (const [key, entry] of clients) if (entry.until <= now) clients.delete(key);
      nextCleanup = now + 60_000;
    }
    let entry = clients.get(ip);
    if (!entry || entry.until <= now) {
      if (!entry && clients.size >= 4096) return 60;
      entry = { count: 0, until: now + hour };
      clients.set(ip, entry);
    }
    if (entry.count >= 10) return Math.ceil((entry.until - now) / 1000);
    entry.count++;
    return 0;
  }

  async function handle(req, res) {
    const path = req.url?.split('?')[0];
    if (req.method === 'GET' && path === '/healthz') {
      const ok = await isReady();
      return send(res, ok ? 200 : 503, { ok, service: 'memphis-public-chat-gateway', tier: 0, provider: 'ollama' });
    }
    if (req.method === 'GET' && (path === '/' || path === '/chat')) {
      res.writeHead(302, { Location: '/chat/' });
      return res.end();
    }
    if (req.method === 'GET' && pages.has(path)) {
      const [file, type] = pages.get(path);
      const content = await readFile(new URL('../sites/memphis-v5/chat/' + file, import.meta.url));
      res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      return res.end(content);
    }
    if (path !== '/chat' && path !== '/chat/api.php') return send(res, 404, { ok: false, error: 'not_found' });
    if (req.headers.origin === 'https://memphis-v5.pl') {
      res.setHeader('Access-Control-Allow-Origin', 'https://memphis-v5.pl');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' });
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
      return send(res, 415, { ok: false, error: 'invalid_input' });
    const body = await readBody(req);
    if (body.status) return send(res, body.status, { ok: false, error: 'invalid_input' }, { Connection: 'close' });
    if (active >= 1) return send(res, 503, { ok: false, error: 'busy' }, { 'Retry-After': '5' });
    const peer = req.socket.remoteAddress;
    const forwarded = req.headers['x-real-ip'];
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
    const ip = trustProxy && local && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : peer;
    const retry = allowance(ip);
    if (retry) return send(res, 429, { ok: false, error: 'rate_limited' }, { 'Retry-After': String(retry) });

    active++;
    const disconnected = new AbortController();
    const close = () => disconnected.abort();
    res.once('close', close);
    const started = Date.now();
    try {
      const response = await request(ollama + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        signal: globalThis.AbortSignal.any([disconnected.signal, globalThis.AbortSignal.timeout(70_000)]),
        body: JSON.stringify({ model, messages: body.messages, stream: false, keep_alive: '5m',
          options: { num_ctx: 4096, num_predict: 192, num_thread: 2 } }),
      });
      if (!response.ok) throw new Error('model unavailable');
      const data = await response.json();
      const reply = typeof data.message?.content === 'string'
        ? data.message.content.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '').split(/<\/think>/i).at(-1).trim()
        : '';
      if (!reply || data.done !== true || data.message.tool_calls?.length) throw new Error('no public reply');
      send(res, 200, { ok: true, reply, sessionId: body.sessionId,
        meta: { model, latency_ms: Date.now() - started } });
    } catch {
      if (!res.destroyed) send(res, 502, { ok: false, error: 'backend_unavailable' });
    } finally {
      res.off('close', close);
      active--;
    }
  }

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
    handle(req, res).catch(() => {
      if (!res.destroyed && !res.headersSent) send(res, 500, { ok: false, error: 'backend_unavailable' });
    });
  });
  server.maxConnections = 64;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createPublicChatServer({ trustProxy: process.env.PUBLIC_CHAT_TRUST_PROXY === '1' });
  server.listen(Number(process.env.PUBLIC_CHAT_PORT || 9100), process.env.PUBLIC_CHAT_HOST || '127.0.0.1');
  const stop = () => server.close();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
