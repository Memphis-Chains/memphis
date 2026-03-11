import { AppError, errorTemplates } from '../../core/errors.js';

type SharedGenerateRequest = {
  input: string;
  model?: string;
  options?: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  };
};

type SharedGenerateResponse = {
  output: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
};

export class SharedLlmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly defaultTimeoutMs = 30_000,
  ) {}

  public async healthCheck(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const started = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      if (!res.ok) {
        return { ok: false, error: `HTTP_${res.status}` };
      }

      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown health check error',
      };
    }
  }

  public async generate(payload: SharedGenerateRequest): Promise<SharedGenerateResponse> {
    const timeoutMs = payload.options?.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/v1/generate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (res.status === 429) {
        throw new AppError('PROVIDER_RATE_LIMIT', 'Shared provider rate limited', 429);
      }

      if (res.status === 401 || res.status === 403) {
        throw errorTemplates.invalidApiKey({
          provider: 'shared-llm',
          status: res.status,
        });
      }

      if (res.status >= 500) {
        throw new AppError('PROVIDER_UNAVAILABLE', `Shared provider unavailable: HTTP_${res.status}`, 503);
      }

      if (!res.ok) {
        throw new AppError('INTERNAL_ERROR', `Shared provider request failed: HTTP_${res.status}`, 500);
      }

      const data = (await res.json()) as SharedGenerateResponse;
      if (!data.output || typeof data.output !== 'string') {
        throw new AppError('INTERNAL_ERROR', 'Invalid shared provider response payload', 500);
      }

      return data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AppError('PROVIDER_TIMEOUT', 'Shared provider timeout', 504);
      }
      throw errorTemplates.network({
        target: this.baseUrl,
        message: 'Shared provider unreachable',
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
