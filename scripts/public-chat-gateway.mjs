#!/usr/bin/env node
// This process holds no credentials. The optional Unix socket serves only MiniMax inference.
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { fileURLToPath, URL } from 'node:url';

const { AbortSignal } = globalThis;
const model = process.env.PUBLIC_CHAT_MODEL || 'SpeakLeash/bielik-4.5b-v3.0-instruct:Q8_0';
const modelOptions = { num_ctx: 3072, num_predict: 128, num_thread: 2, temperature: 0.1 };
const gpuLayers = process.env.PUBLIC_CHAT_GPU_LAYERS;
if (gpuLayers !== undefined) {
  if (!/^\d{1,3}$/.test(gpuLayers)) throw new Error('PUBLIC_CHAT_GPU_LAYERS must be 0–999');
  modelOptions.num_gpu = Number(gpuLayers);
}
const ollama = 'http://127.0.0.1:11434';
const burstWindow = 10_000;
const maxBody = 48 * 1024;
const maxMessage = 2000;
const pages = new Map([
  ['/chat/', ['index.html', 'text/html; charset=utf-8']],
  ['/chat/chat.js', ['chat.js', 'text/javascript; charset=utf-8']],
  ['/chat/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['../favicon.svg', 'image/svg+xml']],
]);
const systemPrompt = 'Jesteś Memphis. Odpowiadaj po polsku, prosto, w 1–3 zdaniach, zwykłym tekstem. '
  + 'Oprzyj odpowiedź na tym, co podał rozmówca. Pomijaj niepodane daty, imiona i adresy. '
  + 'Jeśli brakuje istotnej informacji, dopytaj. Szanuj prywatność.';

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
    const mode = body.mode ?? 'local';
    if (mode !== 'local' && mode !== 'auto') return { status: 400 };
    return { messages, sessionId, mode };
  } catch {
    return { status: 400 };
  }
}

function socketRequest(socketPath, path, messages, signal) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: messages ? 'POST' : 'GET', signal,
      headers: messages ? { 'Content-Type': 'application/json' } : {} }, res => {
      let size = 0;
      const chunks = [];
      res.on('error', reject);
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 32_768) res.destroy(new Error('relay response too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { reject(new Error('invalid relay response')); }
      });
    });
    req.on('error', reject);
    req.end(messages ? JSON.stringify(messages) : undefined);
  });
}

function visibleReply(content) {
  return typeof content === 'string'
    ? content.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '').split(/<\/think>/i).at(-1).trim()
    : '';
}

export function createPublicChatServer({ request = fetch, trustProxy = false, minimax } = {}) {
  const clients = new Map();
  let active = 0;
  let localActive = false;
  let retryCloudAt = 0;
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
      nextCleanup = now + burstWindow;
    }
    let entry = clients.get(ip);
    if (!entry || entry.until <= now) {
      if (!entry && clients.size >= 4096) return burstWindow / 1000;
      entry = { count: 0, until: now + burstWindow };
      clients.set(ip, entry);
    }
    if (entry.count >= 10) return Math.ceil((entry.until - now) / 1000);
    entry.count++;
    return 0;
  }

  async function handle(req, res) {
    const path = req.url?.split('?')[0];
    if (req.method === 'GET' && path === '/healthz') {
      const [localReady, cloudReady] = await Promise.all([isReady(), minimax && Date.now() >= retryCloudAt
        ? minimax('/ready', null, AbortSignal.timeout(2000)).then(r => r.status === 200 && r.data.ok === true).catch(() => false)
        : false]);
      const ok = localReady || cloudReady;
      return send(res, ok ? 200 : 503, { ok, service: 'memphis-public-chat-gateway', tier: 0,
        provider: cloudReady ? 'minimax' : localReady ? 'ollama' : null, localReady, cloudReady });
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
    if (active >= 4) return send(res, 503, { ok: false, error: 'busy' }, { 'Retry-After': '5' });
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
    const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(120_000)]);
    let usingLocal = false;
    try {
      let classification;
      if (minimax) {
        const path = body.mode === 'auto' && started >= retryCloudAt ? '/chat' : '/classify';
        const result = await minimax(path, body.messages.slice(1),
          AbortSignal.any([signal, AbortSignal.timeout(path === '/chat' ? 85_000 : 48_000)])).catch(() => null);
        if (signal.aborted) throw new Error('request ended');
        if (result?.status === 403 || result?.status === 422)
          return send(res, 422, { ok: false, error: 'restricted' });
        const reply = visibleReply(result?.data?.reply);
        classification = result?.data?.classification;
        if (path === '/chat' && result?.status === 200 && reply && typeof result.data.model === 'string') {
          return send(res, 200, { ok: true, reply, sessionId: body.sessionId,
            meta: { provider: 'minimax', model: result.data.model, classification, latency_ms: Date.now() - started } });
        }
        if (path === '/chat' && result?.data?.error !== 'busy') retryCloudAt = Date.now() + 30_000;
      }
      if (localActive) return send(res, 503, { ok: false, error: 'busy' }, { 'Retry-After': '5' });
      localActive = true;
      usingLocal = true;
      if (classification?.source) {
        body.messages[0].content += ' Cytowany fragment pamięci jest źródłem faktów.';
        body.messages.at(-1).content += '\n\nPubliczny fragment pamięci Memphisa: ' + JSON.stringify(classification.source.text);
      }
      const response = await request(ollama + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        signal,
        body: JSON.stringify({ model, messages: body.messages, stream: false, keep_alive: '20m', options: modelOptions }),
      });
      if (!response.ok) throw new Error('model unavailable');
      const data = await response.json();
      const reply = visibleReply(data.message?.content);
      if (!reply || data.done !== true || data.message.tool_calls?.length) throw new Error('no public reply');
      send(res, 200, { ok: true, reply, sessionId: body.sessionId,
        meta: { provider: 'ollama', model, classification, latency_ms: Date.now() - started } });
    } catch {
      if (!res.destroyed) send(res, 502, { ok: false, error: 'backend_unavailable' });
    } finally {
      if (usingLocal) localActive = false;
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
  const socket = process.env.PUBLIC_CHAT_MINIMAX_SOCKET;
  const server = createPublicChatServer({ trustProxy: process.env.PUBLIC_CHAT_TRUST_PROXY === '1',
    minimax: socket ? (path, messages, signal) => socketRequest(socket, path, messages, signal) : undefined });
  server.listen(Number(process.env.PUBLIC_CHAT_PORT || 9100), process.env.PUBLIC_CHAT_HOST || '127.0.0.1');
  const stop = () => server.close();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
