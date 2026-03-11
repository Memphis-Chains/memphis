/**
 * Memphis Gateway — HTTP API for agent control
 *
 * Endpoints:
 *   GET  /health              — health check
 *   GET  /status              — system status (chains, providers, vault)
 *   POST /ask                 — ask Memphis (LLM + recall)
 *   POST /journal             — add journal entry
 *   POST /exec                — execute shell command (auth required)
 *   GET  /chains              — list chains
 *   GET  /chains/:name        — get chain blocks
 *   GET  /chains/:name/:index — get single block
 *   POST /recall              — search memory
 *   GET  /providers           — list available LLM providers
 *   POST /provider/chat       — direct LLM chat
 *
 * Auth: Bearer token from vault (gateway.auth.token in config)
 */

import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { getSystemInfo, exec } from '../agent/system.js';

export interface GatewayConfig {
  port: number;
  host: string;
  authToken?: string;
}

type Handler = (req: IncomingMessage, body: string) => Promise<unknown>;
type Route = { method: string; path: string; handler: Handler; auth: boolean };

export class Gateway {
  private config: GatewayConfig;
  private routes: Route[] = [];
  private chainsDir: string;
  private dataDir: string;

  constructor(config: GatewayConfig, chainsDir: string, dataDir: string) {
    this.config = config;
    this.chainsDir = chainsDir;
    this.dataDir = dataDir;
    this.registerRoutes();
  }

  private registerRoutes() {
    this.route('GET', '/health', false, async () => ({
      status: 'ok',
      version: '4.0.0',
      timestamp: new Date().toISOString(),
    }));

    this.route('GET', '/status', false, async () => {
      const sys = getSystemInfo();
      // In production: call chain_status via napi bridge
      return { system: sys, chains: 'use napi bridge' };
    });

    this.route('POST', '/journal', true, async (_req, body) => {
      const { message, tags } = JSON.parse(body);
      if (!message) return { error: 'message required' };
      // In production: call chain_append via napi bridge
      return { ok: true, chain: 'journal', message };
    });

    this.route('POST', '/exec', true, async (_req, body) => {
      const { command, cwd, timeout } = JSON.parse(body);
      if (!command) return { error: 'command required' };
      const result = exec(command, { cwd, timeout });
      return result;
    });

    this.route('POST', '/recall', true, async (_req, body) => {
      const { keyword, chain, limit } = JSON.parse(body);
      if (!keyword) return { error: 'keyword required' };
      // In production: call chain_query via napi bridge
      return { keyword, chain, limit, results: [] };
    });

    this.route('GET', '/providers', false, async () => {
      // In production: list configured providers
      return { providers: ['ollama', 'minimax'] };
    });

    this.route('POST', '/provider/chat', true, async (_req, body) => {
      const { messages, model, provider } = JSON.parse(body);
      if (!messages) return { error: 'messages required' };
      // In production: resolve provider and chat
      return { content: 'gateway chat placeholder', model, provider };
    });
  }

  private route(method: string, path: string, auth: boolean, handler: Handler) {
    this.routes.push({ method, path, handler, auth });
  }

  async start(): Promise<void> {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const route = this.routes.find((r) => r.method === req.method && r.path === url.pathname);

      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (!route) {
        this.json(res, 404, { error: 'not found' });
        return;
      }

      // Auth check
      if (route.auth && this.config.authToken) {
        const auth = req.headers.authorization;
        if (!auth || auth !== `Bearer ${this.config.authToken}`) {
          this.json(res, 401, { error: 'unauthorized' });
          return;
        }
      }

      try {
        const body = await readBody(req);
        const result = await route.handler(req, body);
        this.json(res, 200, result);
      } catch (err: any) {
        this.json(res, 500, { error: err.message });
      }
    });

    server.listen(this.config.port, this.config.host, () => {
      console.log(`🌐 Memphis Gateway running on http://${this.config.host}:${this.config.port}`);
    });
  }

  private json(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

export function startGateway(config: GatewayConfig, chainsDir: string, dataDir: string) {
  const gw = new Gateway(config, chainsDir, dataDir);
  return gw.start();
}
