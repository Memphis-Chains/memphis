import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppContainer } from '../../src/app/container.js';
import { createHttpServer } from '../../src/infra/http/server.js';
import type { AppConfig } from '../../src/infra/config/schema.js';

function cfg(db: string): AppConfig {
  return {
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 0, LOG_LEVEL: 'error',
    DEFAULT_PROVIDER: 'local-fallback',
    SHARED_LLM_API_BASE: undefined, SHARED_LLM_API_KEY: undefined,
    DECENTRALIZED_LLM_API_BASE: undefined, DECENTRALIZED_LLM_API_KEY: undefined,
    LOCAL_FALLBACK_ENABLED: true,
    GEN_TIMEOUT_MS: 30000, GEN_MAX_TOKENS: 512, GEN_TEMPERATURE: 0.4,
    RUST_CHAIN_ENABLED: false,
    RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
    DATABASE_URL: `file:${db}`,
  };
}

describe('Prometheus metrics endpoint', () => {
  it('serves text exposition on /metrics with expected core series', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-prom-'));
    writeFileSync(join(dir, 'chain.json'), JSON.stringify({ blocks: [{ idx: 1 }, { idx: 2 }] }));

    const prevMetricsScanDir = process.env.METRICS_CHAIN_SCAN_DIR;
    const prevMetricsEnabled = process.env.METRICS_ENABLED;
    process.env.METRICS_CHAIN_SCAN_DIR = dir;
    process.env.METRICS_ENABLED = 'true';

    const conf = cfg(join(dir, 'metrics.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
    });

    await app.inject({ method: 'POST', url: '/v1/chat/generate', payload: { input: 'metrics', provider: 'auto' } });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain; version=0.0.4');

    const text = res.body;
    expect(text).toContain('requests_total');
    expect(text).toContain('request_duration_seconds_bucket');
    expect(text).toContain('errors_total');
    expect(text).toContain('chain_blocks_total 2');
    expect(text).toContain('embed_queries_total');
    expect(text).toContain('ask_requests_total{provider="local-fallback"}');

    await app.close();
    process.env.METRICS_CHAIN_SCAN_DIR = prevMetricsScanDir;
    process.env.METRICS_ENABLED = prevMetricsEnabled;
  });

  it('returns 404 when METRICS_ENABLED=false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-prom-off-'));
    const prevMetricsEnabled = process.env.METRICS_ENABLED;
    process.env.METRICS_ENABLED = 'false';

    const conf = cfg(join(dir, 'metrics-off.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
    });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);

    await app.close();
    process.env.METRICS_ENABLED = prevMetricsEnabled;
  });
});
