import { SecurityManager } from './security.js';
import type { MemphisRecallHit } from './types.js';

interface JsonResponse {
  ok?: boolean;
  [key: string]: unknown;
}

interface MemphisClientConfig {
  baseUrl?: string;
  timeoutMs?: number;
  apiKey?: string;
  userId?: string;
  auditLogPath?: string;
}

export class MemphisClient {
  private readonly security: SecurityManager;
  private readonly apiKey?: string;
  private readonly userId: string;

  constructor(private readonly config: MemphisClientConfig = {}) {
    this.security = new SecurityManager(config.auditLogPath);
    this.apiKey = config.apiKey;
    this.userId = config.userId?.trim() || 'anonymous';
  }

  async search(query: string, limit = 10): Promise<MemphisRecallHit[]> {
    this.assertSafeInput('search.query', query);
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 10;

    const json = await this.request<{ ok: boolean; results?: MemphisRecallHit[] }>('/api/recall', {
      method: 'POST',
      body: { query, limit: safeLimit },
    });

    return Array.isArray(json.results) ? json.results : [];
  }

  async save(content: string, tags?: string[]): Promise<{ success: boolean; id: string }> {
    this.assertSafeInput('save.content', content);

    const safeTags = tags
      ?.filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)
      .filter((tag) => this.security.validateInput(tag));

    const json = await this.request<{ ok: boolean; index?: number; hash?: string }>(
      '/api/journal',
      {
        method: 'POST',
        body: { content, tags: safeTags },
      },
    );

    return {
      success: Boolean(json.ok),
      id: typeof json.hash === 'string' ? json.hash : String(json.index ?? ''),
    };
  }

  async decide(title: string, content: string, tags?: string[]): Promise<{ success: boolean }> {
    this.assertSafeInput('decide.title', title);
    this.assertSafeInput('decide.content', content);

    const safeTags = tags
      ?.filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)
      .filter((tag) => this.security.validateInput(tag));

    const json = await this.request<{ ok: boolean }>('/api/decide', {
      method: 'POST',
      body: { title, content, tags: safeTags },
    });

    return { success: Boolean(json.ok) };
  }

  private async request<T extends JsonResponse>(
    path: string,
    init: { method: string; body?: Record<string, unknown> },
  ): Promise<T> {
    const safePath = this.security.sanitizePath(path);

    if (!this.security.checkRateLimit(this.userId)) {
      this.security.logAudit('rate_limit_exceeded', { userId: this.userId, path: safePath });
      throw new Error('Rate limit exceeded (100 req/min)');
    }

    if (init.body && !this.security.validateInput(JSON.stringify(init.body))) {
      this.security.logAudit('blocked_payload', { userId: this.userId, path: safePath });
      throw new Error('Unsafe payload blocked by security policy');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 5000);

    try {
      const response = await fetch(`${this.config.baseUrl ?? 'http://localhost:3000'}${safePath}`, {
        method: init.method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        this.security.logAudit('upstream_error', {
          userId: this.userId,
          path: safePath,
          status: response.status,
        });
        throw new Error(`Memphis API ${safePath} failed: ${response.status}`);
      }

      this.security.logAudit('request_ok', { userId: this.userId, path: safePath });
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertSafeInput(field: string, value: string): void {
    if (!this.security.validateInput(value)) {
      this.security.logAudit('invalid_input', { userId: this.userId, field });
      throw new Error(`Invalid or unsafe input in ${field}`);
    }
  }
}
