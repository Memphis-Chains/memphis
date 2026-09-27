#!/usr/bin/env node
/* eslint-env node */
// public-chat-gateway.mjs — tier-0 public chat gateway for memphis-v5.pl/chat
//
// Contract (mirror of chat.js frontend expectation):
//   POST /chat { message: string, sessionId?: string }
//     → 200 { ok: true, reply: string, sessionId: string }
//     → 400 { ok: false, error: "invalid_input" }
//     → 429 { ok: false, error: "rate_limited" }
//     → 502 { ok: false, error: "backend_unavailable" }
//   GET /healthz → 200 { ok: true, runtime, uptime_s, ... }
//
// Tier: 0 (public surface, no vault, no tools, no filesystem access)
// Subprocess: `node memphis/dist/infra/cli/index.js chat --input ... --json`
// Strip <think>...</think> reasoning block from output (M3 model adds it)
//
// Port: 9100 (env PUBLIC_CHAT_PORT)
// Host: 127.0.0.1 only (fronted by Cloudflare Tunnel api.memphis-v5.pl)
// Log: ~/.memphis/logs/public-chat-gateway.log

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const PORT = parseInt(process.env.PUBLIC_CHAT_PORT || '9100', 10);
const HOST = process.env.PUBLIC_CHAT_HOST || '127.0.0.1';
const MEMPHIS_BIN = process.env.MEMPHIS_BIN
  || '/home/memphis/memphis/dist/infra/cli/index.js';
const PROVIDER = process.env.PUBLIC_CHAT_PROVIDER || 'minimax';
const SUBPROC_TIMEOUT_MS = parseInt(process.env.PUBLIC_CHAT_TIMEOUT_MS || '75000', 10);
const MAX_MSG_LEN = 2000;
const RATE_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

const LOG_DIR = process.env.HOME + '/.memphis/logs';
const LOG_FILE = LOG_DIR + '/public-chat-gateway.log';

await mkdir(LOG_DIR, { recursive: true });

// ---------- logging ----------
async function log(level, event, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const line = JSON.stringify(entry) + '\n';
  try {
    await appendFile(LOG_FILE, line);
  } catch (e) {
    console.error('log_failed', e.message);
  }
  if (level === 'error') console.error(line.trim());
}

// ---------- rate limit (in-memory) ----------
const rateMap = new Map(); // ip -> { count, resetAt }
function rateCheck(ip) {
  const now = Date.now();
  const rec = rateMap.get(ip);
  if (!rec || now > rec.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + HOUR_MS });
    return { ok: true, left: RATE_PER_HOUR - 1 };
  }
  if (rec.count >= RATE_PER_HOUR) {
    return { ok: false, left: 0, resetAt: rec.resetAt };
  }
  rec.count += 1;
  return { ok: true, left: RATE_PER_HOUR - rec.count };
}

// Cleanup expired entries every 10 min
const cleanupTimer = globalThis.setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateMap.entries()) {
    if (now > v.resetAt + HOUR_MS) rateMap.delete(k);
  }
}, 10 * 60 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();

// ---------- memphis subprocess ----------
function callMemphis(message) {
  return new Promise((resolve) => {
    if (!existsSync(MEMPHIS_BIN)) {
      log('error', 'memphis_bin_missing', { path: MEMPHIS_BIN });
      return resolve({ ok: false, error: 'backend_unavailable' });
    }

    const args = [
      MEMPHIS_BIN,
      'chat',
      '--input', message,
      '--json',
      '--provider', PROVIDER,
      '--actor-id', 'public-chat:v1',
    ];
    const start = Date.now();
    const proc = spawn('/usr/bin/node', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // tier-0 surface — strip any vault tokens
        MEMPHIS_VAULT_PEPPER: undefined,
      },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      log('warning', 'subprocess_timeout', { timeout_ms: SUBPROC_TIMEOUT_MS });
    }, SUBPROC_TIMEOUT_MS);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (e) => {
      clearTimeout(timer);
      log('error', 'subprocess_error', { error: e.message });
      resolve({ ok: false, error: 'backend_unavailable' });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const latency = Date.now() - start;

      if (killed) {
        return resolve({ ok: false, error: 'backend_unavailable' });
      }

      if (code !== 0) {
        log('warning', 'subprocess_nonzero_exit', {
          exit_code: code,
          stderr_tail: stderr.slice(-300),
          latency_ms: latency,
        });
        return resolve({ ok: false, error: 'backend_unavailable' });
      }

      // JSON output starts after log lines — find first '{'
      const jsonStart = stdout.indexOf('{');
      if (jsonStart === -1) {
        log('warning', 'no_json_in_output', { stdout_tail: stdout.slice(-300) });
        return resolve({ ok: false, error: 'backend_unavailable' });
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout.slice(jsonStart));
      } catch (e) {
        log('warning', 'json_parse_failed', { error: e.message });
        return resolve({ ok: false, error: 'backend_unavailable' });
      }

      if (!parsed.output || typeof parsed.output !== 'string') {
        log('warning', 'no_output_field', { keys: Object.keys(parsed) });
        return resolve({ ok: false, error: 'backend_unavailable' });
      }

      // Strip <think>...</think> reasoning block (M3 model)
      const reply = parsed.output
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim();

      log('info', 'reply_ok', {
        latency_ms: latency,
        model: parsed.modelUsed,
        provider: parsed.providerUsed,
        turn_id: parsed.id,
        input_len: message.length,
        output_len: reply.length,
      });

      resolve({
        ok: true,
        reply: reply || parsed.output.trim(),
        model: parsed.modelUsed,
        latency_ms: latency,
      });
    });
  });
}

// ---------- helpers ----------
function clientIp(req) {
  // Trust X-Forwarded-For only if behind known proxy; for CF Tunnel use cf-connecting-ip
  return req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || 'unknown';
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': 'https://memphis-v5.pl',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

// ---------- request handler ----------
async function handleChat(req, res, body) {
  const ip = clientIp(req);

  if (!body || typeof body.message !== 'string') {
    log('warning', 'invalid_input', { ip, body_keys: body ? Object.keys(body) : null });
    return sendJson(res, 400, { ok: false, error: 'invalid_input' });
  }

  const message = body.message.trim();
  if (!message || message.length > MAX_MSG_LEN) {
    log('warning', 'invalid_input', { ip, len: message.length, reason: 'length' });
    return sendJson(res, 400, { ok: false, error: 'invalid_input' });
  }

  const rate = rateCheck(ip);
  if (!rate.ok) {
    log('info', 'rate_limited', { ip, reset_in_min: Math.ceil((rate.resetAt - Date.now()) / 60000) });
    res.setHeader('Retry-After', Math.ceil((rate.resetAt - Date.now()) / 1000));
    return sendJson(res, 429, { ok: false, error: 'rate_limited' });
  }

  const sessionId = (typeof body.sessionId === 'string' && /^sess_[A-Za-z0-9_]{1,40}$/.test(body.sessionId))
    ? body.sessionId
    : 'sess_' + randomUUID().replace(/-/g, '').slice(0, 16);

  const result = await callMemphis(message);

  if (!result.ok) {
    return sendJson(res, 502, { ok: false, error: result.error });
  }

  return sendJson(res, 200, {
    ok: true,
    reply: result.reply,
    sessionId,
    meta: {
      model: result.model,
      latency_ms: result.latency_ms,
    },
  });
}

// ---------- server ----------
const startTime = Date.now();

const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }

  if (req.method === 'GET' && req.url === '/healthz') {
    return sendJson(res, 200, {
      ok: true,
      service: 'memphis-public-chat-gateway',
      tier: 0,
      provider: PROVIDER,
      memphis_bin_exists: existsSync(MEMPHIS_BIN),
      uptime_s: Math.floor((Date.now() - startTime) / 1000),
      rate_map_size: rateMap.size,
    });
  }

  if (req.method !== 'POST' || req.url !== '/chat') {
    return sendJson(res, 404, { ok: false, error: 'not_found' });
  }

  // Read body
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => {
    raw += c;
    if (raw.length > MAX_MSG_LEN + 100) {
      req.destroy();
    }
  });
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_input' });
    }
    try {
      await handleChat(req, res, body);
    } catch (e) {
      log('error', 'handler_exception', { error: e.message, stack: e.stack });
      sendJson(res, 500, { ok: false, error: 'backend_unavailable' });
    }
  });
});

server.listen(PORT, HOST, () => {
  log('info', 'gateway_start', {
    host: HOST,
    port: PORT,
    provider: PROVIDER,
    memphis_bin: MEMPHIS_BIN,
    pid: process.pid,
  });
  console.log(`[public-chat-gateway] listening on http://${HOST}:${PORT}`);
  console.log(`  provider=${PROVIDER} memphis_bin=${MEMPHIS_BIN}`);
});

process.on('SIGTERM', () => {
  log('info', 'sigterm_received');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  log('info', 'sigint_received');
  server.close(() => process.exit(0));
});
