import type { MemphisRecallHit } from './types.js';

interface JsonResponse {
  ok?: boolean;
  [key: string]: unknown;
}

export class MemphisClient {
  constructor(
    private readonly baseUrl: string = 'http://localhost:3000',
    private readonly timeoutMs: number = 5000,
  ) {}

  async search(query: string, limit = 10): Promise<MemphisRecallHit[]> {
    const json = await this.request<{ ok: boolean; results?: MemphisRecallHit[] }>('/api/recall', {
      method: 'POST',
      body: { query, limit },
    });

    return Array.isArray(json.results) ? json.results : [];
  }

  async save(content: string, tags?: string[]): Promise<{ success: boolean; id: string }> {
    const json = await this.request<{ ok: boolean; index?: number; hash?: string }>('/api/journal', {
      method: 'POST',
      body: { content, tags },
    });

    return {
      success: Boolean(json.ok),
      id: typeof json.hash === 'string' ? json.hash : String(json.index ?? ''),
    };
  }

  async decide(title: string, content: string, tags?: string[]): Promise<{ success: boolean }> {
    const json = await this.request<{ ok: boolean }>('/api/decide', {
      method: 'POST',
      body: { title, content, tags },
    });

    return { success: Boolean(json.ok) };
  }

  private async request<T extends JsonResponse>(
    path: string,
    init: { method: string; body?: Record<string, unknown> },
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: { 'Content-Type': 'application/json' },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Memphis API ${path} failed: ${response.status}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
