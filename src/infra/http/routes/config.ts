import { z } from 'zod';

import { writeSecurityAudit } from '../../logging/security-audit.js';
import {
  appendBlock,
  getConfigKeys,
  getConfigValue,
  getConfigHistory,
  type ConfigHistoryEntry,
} from '../../storage/chain-adapter.js';

const configSetSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.string().min(1).max(50000),
});

const configDeleteSchema = z.object({
  key: z.string().min(1).max(200),
});

type ConfigRouteApp = {
  post: (
    path: string,
    handler: (request: { body: unknown; ip: string; id: string }) => Promise<unknown>,
  ) => void;
  get: (
    path: string,
    handler: (request: { query: unknown; ip: string; id: string }) => Promise<unknown>,
  ) => void;
  delete: (
    path: string,
    handler: (request: { body: unknown; ip: string; id: string }) => Promise<unknown>,
  ) => void;
};

export function registerConfigRoutes(app: ConfigRouteApp): void {
  // POST /v1/config/set — append a config block to the journal chain
  app.post('/v1/config/set', async (request) => {
    const parsed = configSetSchema.safeParse(request.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: 'Invalid request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      };
    }

    const { key, value } = parsed.data;

    try {
      await appendBlock('journal', { type: 'config', key, value });

      writeSecurityAudit({
        action: 'config.set',
        status: 'allowed',
        ip: request.ip,
        route: '/v1/config/set',
        details: { key },
      });

      return { ok: true, key, value };
    } catch (error) {
      writeSecurityAudit({
        action: 'config.set',
        status: 'error',
        ip: request.ip,
        route: '/v1/config/set',
        details: { key, message: error instanceof Error ? error.message : 'unknown' },
      });
      throw error;
    }
  });

  // GET /v1/config/get?key=<key> — read latest config value from journal chain
  app.get('/v1/config/get', async (request) => {
    const query = request.query as { key?: string };
    const key = query.key;

    if (!key || typeof key !== 'string') {
      return { ok: false, error: 'key query parameter is required' };
    }

    try {
      const value = await getConfigValue(key);
      return { ok: true, key, value };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'failed to read config',
      };
    }
  });

  // GET /v1/config/list — list all config keys stored in the journal
  app.get('/v1/config/list', async () => {
    try {
      const keys = await getConfigKeys();
      return { ok: true, keys };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'failed to list config keys',
      };
    }
  });

  // GET /v1/config/history?key=<key> — get full change history for a config key
  app.get('/v1/config/history', async (request) => {
    const query = request.query as { key?: string };
    const key = query.key;

    if (!key || typeof key !== 'string') {
      return { ok: false, error: 'key query parameter is required' };
    }

    try {
      const history: ConfigHistoryEntry[] = await getConfigHistory(key);
      return { ok: true, key, history };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'failed to read config history',
      };
    }
  });

  // DELETE /v1/config/delete — tombstone a config key (append tombstone to journal)
  app.delete('/v1/config/delete', async (request) => {
    const parsed = configDeleteSchema.safeParse(request.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: 'Invalid request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      };
    }

    const { key } = parsed.data;

    try {
      await appendBlock('journal', { type: 'config', key, value: null });

      writeSecurityAudit({
        action: 'config.delete',
        status: 'allowed',
        ip: request.ip,
        route: '/v1/config/delete',
        details: { key },
      });

      return { ok: true, key, deleted: true };
    } catch (error) {
      writeSecurityAudit({
        action: 'config.delete',
        status: 'error',
        ip: request.ip,
        route: '/v1/config/delete',
        details: { key, message: error instanceof Error ? error.message : 'unknown' },
      });
      throw error;
    }
  });
}
