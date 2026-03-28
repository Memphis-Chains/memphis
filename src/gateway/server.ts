import * as crypto from 'node:crypto';
import { IncomingMessage, ServerResponse, createServer } from 'node:http';

import {
  GatewayExecPolicy,
  assertGatewayExecAuthConfigured,
  enforceGatewayExecAuth,
  enforceGatewayExecPolicy,
  loadGatewayExecPolicy,
} from './exec-policy.js';
import { exec, getSystemInfo } from '../agent/system.js';
import { createAppContainer } from '../app/container.js';
import { getAppVersion } from '../config/paths.js';
import { AppError, toAppError } from '../core/errors.js';
import { loadConfig as loadAppEnvConfig } from '../infra/config/env.js';
import { execLimiter, globalLimiter, sensitiveLimiter } from '../infra/http/rate-limit.js';
import { metrics } from '../infra/logging/metrics.js';
import { writeSecurityAudit } from '../infra/logging/security-audit.js';
import { computeHealthSummary } from '../infra/ops/health-summary.js';
import { secureCompare } from '../security/constant-time.js';

export interface GatewayConfig {
  port: number;
  host: string;
  authToken?: string;
  dangerouslyAllowExec?: boolean;
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
        suggestion: appError.suggestion,
        details: appError.details ?? {},
        requestId,
      },
    },
  };
}

export class Gateway {
  private config: GatewayConfig;
  private routes: Route[] = [];
  private routeMap = new Map<string, Route>();
  private chainsDir: string;
  private dataDir: string;
  private execPolicy: GatewayExecPolicy;

  constructor(config: GatewayConfig, chainsDir: string, dataDir: string) {
    this.config = config;
    this.chainsDir = chainsDir;
    this.dataDir = dataDir;
    this.execPolicy = loadGatewayExecPolicy();
    if (!this.config.dangerouslyAllowExec) {
      assertGatewayExecAuthConfigured(this.config);
    }
    this.registerRoutes();
  }

  private registerRoutes() {
    this.route('GET', '/health', false, async () => ({
      status: 'ok',
      service: 'memphis-gateway',
      version: getAppVersion(),
      timestamp: new Date().toISOString(),
    }));

    this.route('GET', '/status', false, async () => {
      const sys = getSystemInfo();
      return { system: sys, chainsDir: this.chainsDir, dataDir: this.dataDir };
    });

    this.route('POST', '/exec', true, async (_req, body) => {
      if ((process.env.MEMPHIS_SAFE_MODE ?? '').toLowerCase() === 'true') {
        throw new AppError('PERMISSION_DENIED', 'forbidden in safe mode', 403);
      }
      const { command, cwd, timeout } = parseJsonBody<{
        command?: string;
        cwd?: string;
        timeout?: number;
      }>(body, '/exec');
      if (!command) throw new AppError('VALIDATION_ERROR', 'command required', 400);
      enforceGatewayExecPolicy(command, this.execPolicy);
      return exec(command, { cwd, timeout });
    });

    // Integrated with current orchestration/container

    this.route('GET', '/metrics', true, async () => {
      return metrics.snapshot();
    });

    this.route('GET', '/ops/status', true, async () => {
      const sys = getSystemInfo();
      const config = loadAppEnvConfig();
      const container = createAppContainer(config);
      const providers = await container.orchestration.providersHealth();
      const uptimeSec = Math.floor(process.uptime());
      const health = computeHealthSummary({ providers, uptimeSec });
      return {
        service: 'memphis-gateway',
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

  }

  private route(method: string, path: string, auth: boolean, handler: Handler) {
    const route = { method, path, handler, auth };
    this.routes.push(route);
    this.routeMap.set(routeKey(method, path), route);
  }

  async start(): Promise<void> {
    const server = createServer(async (req, res) => {
      const requestId = req.headers['x-request-id']?.toString() || cryptoRandomId();
      res.setHeader('x-request-id', requestId);

      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const routePath = url.pathname;
      const route = this.routeMap.get(routeKey(req.method ?? '', routePath));

      res.setHeader(
        'Access-Control-Allow-Origin',
        process.env.MEMPHIS_HTTP_CORS_ORIGIN ?? 'http://localhost:3000',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-request-id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'POST' && routePath === '/provider/chat') {
        writeSecurityAudit({
          action: 'gateway.provider-chat',
          status: 'blocked',
          ip: req.socket.remoteAddress ?? undefined,
          route: '/provider/chat',
          details: { reason: 'deprecated_endpoint' },
        });
        this.json(res, 410, {
          ok: false,
          error: 'deprecated',
          message:
            'POST /provider/chat has been removed from the Memphis core chat contract; use POST /v1/chat/generate instead.',
          requestId,
        });
        return;
      }

      if (!route) {
        this.json(res, 404, { error: { code: 'NOT_FOUND', message: 'not found', requestId } });
        return;
      }

      if (url.pathname === '/exec') {
        // Fail-closed: missing or invalid token → 401 blocked (audit logged)
        try {
          enforceGatewayExecAuth(req.headers.authorization, this.config);
        } catch {
          writeSecurityAudit({
            action: 'gateway.exec.auth',
            status: 'blocked',
            ip: req.socket.remoteAddress ?? undefined,
            route: '/exec',
          });
          this.json(res, 401, {
            error: { code: 'UNAUTHORIZED', message: 'unauthorized', requestId },
          });
          return;
        }
      } else if (route.auth) {
        if (!this.config.authToken) {
          this.json(res, 401, {
            error: { code: 'UNAUTHORIZED', message: 'auth token not configured', requestId },
          });
          return;
        }
        const auth = req.headers.authorization;
        if (!auth || !secureCompare(auth, `Bearer ${this.config.authToken}`)) {
          this.json(res, 401, {
            error: { code: 'UNAUTHORIZED', message: 'unauthorized', requestId },
          });
          return;
        }
      }

      try {
        const globalKey = `${req.socket.remoteAddress || 'unknown'}:${req.method || 'UNKNOWN'}`;
        globalLimiter.check(globalKey);

        if (routePath === '/exec') {
          const key = `${req.socket.remoteAddress || 'unknown'}:${req.method}:${routePath}`;
          sensitiveLimiter.check(key);
          execLimiter.check(key);
        }

        const body = await readBody(req);
        if (routePath === '/exec') {
          writeSecurityAudit({
            action: 'gateway.exec.attempt',
            status: 'allowed',
            ip: req.socket.remoteAddress ?? undefined,
            route: '/exec',
            details: { bodyBytes: body.length },
          });
        }
        const result = await route.handler(req, body);
        this.json(res, 200, result);
      } catch (err: unknown) {
        if (url.pathname === '/exec') {
          writeSecurityAudit({
            action: 'gateway.exec.attempt',
            status: 'error',
            ip: req.socket.remoteAddress ?? undefined,
            route: '/exec',
            details: { message: err instanceof Error ? err.message : 'exec_failed' },
          });
        }
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

function routeKey(method: string, path: string): string {
  return `${method}:${path}`;
}

function parseJsonBody<T>(body: string, route: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new AppError('VALIDATION_ERROR', `invalid json body for ${route}`, 400);
  }
}

const MAX_BODY_BYTES = 1_048_576; // 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new AppError('VALIDATION_ERROR', 'request body too large', 413));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', (err) => reject(err));
  });
}

function cryptoRandomId(): string {
  return crypto.randomUUID();
}

export function startGateway(config: GatewayConfig, chainsDir: string, dataDir: string) {
  const dangerouslyAllowExec =
    config.dangerouslyAllowExec ??
    (process.env.GATEWAY_DANGEROUSLY_ALLOW_EXEC === 'true' &&
      process.env.NODE_ENV !== 'production');
  const gw = new Gateway({ ...config, dangerouslyAllowExec }, chainsDir, dataDir);
  return gw.start();
}
