import { AppError, errorTemplates } from '../../core/errors.js';

type DecentralizedGenerateRequest = {
  input: string;
  model?: string;
  options?: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  };
};

type DecentralizedGenerateResponse = {
  output: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
};

export class DecentralizedLlmClient {
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
        signal: AbortSignal.timeout(2000),
      });

      if (!res.ok) return { ok: false, error: `HTTP_${res.status}` };
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Unknown health check error' };
    }
  }

  public async generate(payload: DecentralizedGenerateRequest): Promise<DecentralizedGenerateResponse> {
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

      if (res.status === 429) throw new AppError('PROVIDER_RATE_LIMIT', 'Decentralized provider rate limited', 429);
      if (res.status === 401 || res.status === 403) {
        throw errorTemplates.invalidApiKey({
          provider: 'decentralized-llm',
          status: res.status,
        });
      }
      if (res.status >= 500) throw new AppError('PROVIDER_UNAVAILABLE', `Decentralized provider unavailable: HTTP_${res.status}`, 503);
      if (!res.ok) throw new AppError('INTERNAL_ERROR', `Decentralized provider request failed: HTTP_${res.status}`, 500);

      const data = (await res.json()) as DecentralizedGenerateResponse;
      if (!data.output || typeof data.output !== 'string') {
        throw new AppError('INTERNAL_ERROR', 'Invalid decentralized provider response payload', 500);
      }

      return data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AppError('PROVIDER_TIMEOUT', 'Decentralized provider timeout', 504);
      }
      throw errorTemplates.network({
        target: this.baseUrl,
        message: 'Decentralized provider unreachable',
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
