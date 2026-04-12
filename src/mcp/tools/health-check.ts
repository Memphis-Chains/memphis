/**
 * memphis_health_check — HTTP health check against one or more targets.
 */

export type HealthTarget = {
  /** URL to check */
  url: string;
  /** Timeout in ms (default 5000) */
  timeout?: number;
  /** Expected status code (default 200) */
  expectedStatus?: number;
};

export type MemphisHealthCheckInput = {
  targets: HealthTarget[];
};

export type HealthCheckResult = {
  url: string;
  status: 'healthy' | 'unhealthy' | 'error';
  statusCode?: number;
  latencyMs: number;
  error?: string;
};

export type MemphisHealthCheckOutput = {
  results: HealthCheckResult[];
  allHealthy: boolean;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TARGETS = 10;

async function checkTarget(target: HealthTarget): Promise<HealthCheckResult> {
  const timeout = target.timeout ?? DEFAULT_TIMEOUT_MS;
  const expectedStatus = target.expectedStatus ?? 200;
  const startMs = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(target.url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'Memphis-HealthCheck/1.0' },
    });

    clearTimeout(timer);

    const latencyMs = Date.now() - startMs;
    const healthy = response.status === expectedStatus;

    return {
      url: target.url,
      status: healthy ? 'healthy' : 'unhealthy',
      statusCode: response.status,
      latencyMs,
      error: healthy ? undefined : `Expected ${expectedStatus}, got ${response.status}`,
    };
  } catch (err) {
    return {
      url: target.url,
      status: 'error',
      latencyMs: Date.now() - startMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runMemphisHealthCheck(
  input: MemphisHealthCheckInput,
): Promise<MemphisHealthCheckOutput> {
  if (!input.targets || input.targets.length === 0) {
    return { results: [], allHealthy: true };
  }

  const targets = input.targets.slice(0, MAX_TARGETS);
  const results = await Promise.all(targets.map(checkTarget));
  const allHealthy = results.every((r) => r.status === 'healthy');

  return { results, allHealthy };
}
