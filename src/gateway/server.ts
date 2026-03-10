import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { getSystemInfo, exec } from '../agent/system.js';
import { loadConfig as loadAppEnvConfig } from '../infra/config/env.js';
import { createAppContainer } from '../app/container.js';
import { AppError, toAppError } from '../core/errors.js';
import { metrics } from '../infra/logging/metrics.js';
import { sensitiveLimiter } from '../infra/http/rate-limit.js';
import { computeHealthSummary } from '../infra/ops/health-summary.js';
import { enforceGatewayExecPolicy, loadGatewayExecPolicy, type GatewayExecPolicy } from './exec-policy.js';

export interface GatewayConfig {
  port: number;
  host: string;
  authToken?: string;
}

type Handler = (req: IncomingMessage, body: string) => Promise<unknown>;
type Route = { method: string; path: string; handler: Handler; auth: boolean };

function jsonError(err: unknown, requestId: string) {
  const appError = toAppError(err);
  return {
    status: appError.statusCode,
    body: {
      error: {
        code: appError.code,
        message: appError.message,
        details: appError.details ?? {},
        requestId,
      },
    },
  };
}

export class Gateway {
  private config: GatewayConfig;
  private routes: Route[] = [];
  private chainsDir: string;
  private dataDir: string;
  private execPolicy: GatewayExecPolicy;

  constructor(config: GatewayConfig, chainsDir: string, dataDir: string) {
    this.config = config;
    this.chainsDir = chainsDir;
    this.dataDir = dataDir;
    this.execPolicy = loadGatewayExecPolicy();
    this.registerRoutes();
  }

  private registerRoutes() {
    this.route('GET', '/health', false, async () => ({
      status: 'ok',
      service: 'memphis-v4-gateway',
      version: '4.0.0',
      timestamp: new Date().toISOString(),
    }));

    this.route('GET', '/status', false, async () => {
      const sys = getSystemInfo();
      return { system: sys, chainsDir: this.chainsDir, dataDir: this.dataDir };
    });

    this.route('POST', '/exec', true, async (_req, body) => {
      const { command, cwd, timeout } = JSON.parse(body) as {
        command?: string;
        cwd?: string;
        timeout?: number;
      };
      if (!command) throw new AppError('VALIDATION_ERROR', 'command required', 400);
      enforceGatewayExecPolicy(command, this.execPolicy);
      return exec(command, { cwd, timeout });
    });

    // Integrated with current orchestration/container

    this.route('GET', '/metrics', false, async () => {
      return metrics.snapshot();
    });


    this.route('GET', '/ops/status', false, async () => {
      const sys = getSystemInfo();
      const config = loadAppEnvConfig();
      const container = createAppContainer(config);
      const providers = await container.orchestration.providersHealth();
      const uptimeSec = Math.floor(process.uptime());
      const health = computeHealthSummary({ providers, uptimeSec });
      return {
        service: 'memphis-v4-gateway',
        uptimeSec,
        host: `${this.config.host}:${this.config.port}`,
        providers,
        metrics: metrics.snapshot(),
        health,
        system: {
          hostname: sys.hostname,
          platform: sys.platform,
          freeMemMb: sys.freeMemMb,
        },
        timestamp: new Date().toISOString(),
      };
    });


    this.route('GET', '/providers', false, async () => {
      const config = loadAppEnvConfig();
      const container = createAppContainer(config);
      const providers = await container.orchestration.providersHealth();
      return {
        defaultProvider: config.DEFAULT_PROVIDER,
        providers,
      };
    });

    this.route('POST', '/provider/chat', true, async (req, body) => {
      const { input, provider, model, sessionId } = JSON.parse(body) as {
        input?: string;
        provider?: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback';
        model?: string;
        sessionId?: string;
      };

      if (!input || input.trim().length === 0) {
        throw new AppError('VALIDATION_ERROR', 'input required', 400);
      }

      const config = loadAppEnvConfig();
      const container = createAppContainer(config);

      if (sessionId) {
        container.sessionRepository.ensureSession(sessionId);
      }

      const result = await container.orchestration.generate({
        input,
        provider: provider ?? 'auto',
        model,
        sessionId,
      });

      container.generationEventRepository.create({
        id: result.id,
        sessionId,
        providerUsed: result.providerUsed,
        modelUsed: result.modelUsed,
        timingMs: result.timingMs,
        requestId: req.headers['x-request-id']?.toString(),
      });

      return result;
    });
  }

  private route(method: string, path: string, auth: boolean, handler: Handler) {
    this.routes.push({ method, path, handler, auth });
  }

  async start(): Promise<void> {
    const server = createServer(async (req, res) => {
      const requestId = req.headers['x-request-id']?.toString() || cryptoRandomId();
      res.setHeader('x-request-id', requestId);

      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const route = this.routes.find((r) => r.method === req.method && r.path === url.pathname);

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-request-id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (!route) {
        this.json(res, 404, { error: { code: 'NOT_FOUND', message: 'not found', requestId } });
        return;
      }

      if (route.auth && this.config.authToken) {
        const auth = req.headers.authorization;
        if (!auth || auth !== `Bearer ${this.config.authToken}`) {
          this.json(res, 401, {
            error: { code: 'UNAUTHORIZED', message: 'unauthorized', requestId },
          });
          return;
        }
      }

      try {
        const routePath = url.pathname;
        if (routePath === '/exec' || routePath === '/provider/chat') {
          const key = `${req.socket.remoteAddress || 'unknown'}:${req.method}:${routePath}`;
          sensitiveLimiter.check(key);
        }

        const body = await readBody(req);
        const result = await route.handler(req, body);
        this.json(res, 200, result);
      } catch (err: unknown) {
        const mapped = jsonError(err, requestId);
        this.json(res, mapped.status, mapped.body);
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(this.config.port, this.config.host, () => {
        resolve();
      });
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

function cryptoRandomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function startGateway(config: GatewayConfig, chainsDir: string, dataDir: string) {
  const gw = new Gateway(config, chainsDir, dataDir);
  return gw.start();
}
