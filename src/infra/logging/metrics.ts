import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

export type ProviderMetric = {
  provider: string;
  success: number;
  failure: number;
  totalLatencyMs: number;
  calls: number;
};

type HttpMetric = {
  method: string;
  route: string;
  statusClass: string;
  count: number;
  errors: number;
  durationCount: number;
  durationSumSeconds: number;
  durationBuckets: number[];
};

const HISTOGRAM_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function labels(input: Record<string, string | number>): string {
  const parts = Object.entries(input).map(([k, v]) => {
    const value = String(v).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    return `${k}="${value}"`;
  });
  return `{${parts.join(',')}}`;
}

function statusClass(code: number): string {
  if (code >= 500) return '5xx';
  if (code >= 400) return '4xx';
  if (code >= 300) return '3xx';
  if (code >= 200) return '2xx';
  return '1xx';
}

function parseBool(v: string | undefined, fallback = true): boolean {
  if (typeof v !== 'string') return fallback;
  return v.toLowerCase() === 'true';
}

function countBlocksInJson(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const obj = raw as { blocks?: unknown; chain?: unknown };
  if (Array.isArray(obj.blocks)) return obj.blocks.length;
  if (Array.isArray(obj.chain)) return obj.chain.length;
  return 0;
}

export class InMemoryMetrics {
  private providerStats = new Map<string, ProviderMetric>();
  private httpStats = new Map<string, HttpMetric>();

  private askRequestsTotal = 0;
  private askRequestsByProvider = new Map<string, number>();
  private askLatencyByProvider = new Map<string, { count: number; sumSeconds: number }>();

  private embedQueriesTotal = 0;
  private embedCacheHitsTotal = 0;
  private embedCacheMissesTotal = 0;

  private chainBlocksTotal = 0;
  private chainSizeBytes = 0;

  public metricsEnabled(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
    return parseBool(rawEnv.METRICS_ENABLED, true);
  }

  public recordHttpRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    const cls = statusClass(statusCode);
    const key = `${method}:${route}:${cls}`;
    const prev = this.httpStats.get(key) ?? {
      method,
      route,
      statusClass: cls,
      count: 0,
      errors: 0,
      durationCount: 0,
      durationSumSeconds: 0,
      durationBuckets: HISTOGRAM_BUCKETS_SECONDS.map(() => 0),
    };

    prev.count += 1;
    if (statusCode >= 400) prev.errors += 1;

    const dSec = Math.max(0, durationMs / 1000);
    prev.durationCount += 1;
    prev.durationSumSeconds += dSec;
    for (let i = 0; i < HISTOGRAM_BUCKETS_SECONDS.length; i += 1) {
      if (dSec <= HISTOGRAM_BUCKETS_SECONDS[i]!) {
        prev.durationBuckets[i]! += 1;
      }
    }

    this.httpStats.set(key, prev);
  }

  public recordProviderCall(provider: string, ok: boolean, latencyMs: number): void {
    const prev = this.providerStats.get(provider) ?? {
      provider,
      success: 0,
      failure: 0,
      totalLatencyMs: 0,
      calls: 0,
    };

    prev.calls += 1;
    prev.totalLatencyMs += latencyMs;
    if (ok) prev.success += 1;
    else prev.failure += 1;

    this.providerStats.set(provider, prev);

    this.askRequestsTotal += 1;
    this.askRequestsByProvider.set(provider, (this.askRequestsByProvider.get(provider) ?? 0) + 1);

    const current = this.askLatencyByProvider.get(provider) ?? { count: 0, sumSeconds: 0 };
    current.count += 1;
    current.sumSeconds += Math.max(0, latencyMs / 1000);
    this.askLatencyByProvider.set(provider, current);
  }

  public recordEmbedQuery(hitCount: number): void {
    this.embedQueriesTotal += 1;
    if (hitCount > 0) this.embedCacheHitsTotal += 1;
    else this.embedCacheMissesTotal += 1;
  }

  public setChainSnapshot(blocksTotal: number, sizeBytes: number): void {
    this.chainBlocksTotal = Math.max(0, Math.floor(blocksTotal));
    this.chainSizeBytes = Math.max(0, Math.floor(sizeBytes));
  }

  public collectChainSnapshot(rawEnv: NodeJS.ProcessEnv = process.env): void {
    const baseDir = resolve(rawEnv.METRICS_CHAIN_SCAN_DIR ?? './data');
    let blocks = 0;
    let bytes = 0;

    try {
      const files = readdirSync(baseDir);
      for (const name of files) {
        if (extname(name) !== '.json') continue;
        const full = join(baseDir, name);
        const s = statSync(full);
        if (!s.isFile()) continue;
        bytes += s.size;
        try {
          const content = readFileSync(full, 'utf8');
          blocks += countBlocksInJson(JSON.parse(content));
        } catch {
          // ignore malformed files for metrics best-effort collection
        }
      }
    } catch {
      // ignore missing dir; keep zeros
    }

    this.setChainSnapshot(blocks, bytes);
  }

  public snapshot() {
    const providers = [...this.providerStats.values()].map((p) => ({
      ...p,
      avgLatencyMs: p.calls > 0 ? Math.round(p.totalLatencyMs / p.calls) : 0,
    }));

    return {
      ts: new Date().toISOString(),
      providers,
      ask: {
        requestsTotal: this.askRequestsTotal,
      },
      embed: {
        queriesTotal: this.embedQueriesTotal,
        cacheHitsTotal: this.embedCacheHitsTotal,
        cacheMissesTotal: this.embedCacheMissesTotal,
      },
      chain: {
        blocksTotal: this.chainBlocksTotal,
        sizeBytes: this.chainSizeBytes,
      },
    };
  }

  public toPrometheus(): string {
    const lines: string[] = [];

    lines.push('# HELP requests_total Total number of HTTP requests processed.');
    lines.push('# TYPE requests_total counter');
    for (const m of this.httpStats.values()) {
      lines.push(`requests_total${labels({ method: m.method, route: m.route, status_class: m.statusClass })} ${m.count}`);
    }

    lines.push('# HELP errors_total Total number of HTTP requests that resulted in error (status >= 400).');
    lines.push('# TYPE errors_total counter');
    for (const m of this.httpStats.values()) {
      lines.push(`errors_total${labels({ method: m.method, route: m.route, status_class: m.statusClass })} ${m.errors}`);
    }

    lines.push('# HELP request_duration_seconds HTTP request latency in seconds.');
    lines.push('# TYPE request_duration_seconds histogram');
    for (const m of this.httpStats.values()) {
      for (let i = 0; i < HISTOGRAM_BUCKETS_SECONDS.length; i += 1) {
        const le = HISTOGRAM_BUCKETS_SECONDS[i]!;
        lines.push(
          `request_duration_seconds_bucket${labels({ method: m.method, route: m.route, status_class: m.statusClass, le })} ${m.durationBuckets[i] ?? 0}`,
        );
      }
      lines.push(
        `request_duration_seconds_bucket${labels({ method: m.method, route: m.route, status_class: m.statusClass, le: '+Inf' })} ${m.durationCount}`,
      );
      lines.push(
        `request_duration_seconds_sum${labels({ method: m.method, route: m.route, status_class: m.statusClass })} ${m.durationSumSeconds.toFixed(6)}`,
      );
      lines.push(
        `request_duration_seconds_count${labels({ method: m.method, route: m.route, status_class: m.statusClass })} ${m.durationCount}`,
      );
    }

    lines.push('# HELP chain_blocks_total Total number of chain blocks discovered in scanned chain JSON files.');
    lines.push('# TYPE chain_blocks_total gauge');
    lines.push(`chain_blocks_total ${this.chainBlocksTotal}`);

    lines.push('# HELP chain_size_bytes Total size in bytes for scanned chain JSON files.');
    lines.push('# TYPE chain_size_bytes gauge');
    lines.push(`chain_size_bytes ${this.chainSizeBytes}`);

    lines.push('# HELP embed_queries_total Total number of embedding search queries.');
    lines.push('# TYPE embed_queries_total counter');
    lines.push(`embed_queries_total ${this.embedQueriesTotal}`);

    lines.push('# HELP embed_cache_hits_total Total number of embedding queries with at least one result.');
    lines.push('# TYPE embed_cache_hits_total counter');
    lines.push(`embed_cache_hits_total ${this.embedCacheHitsTotal}`);

    lines.push('# HELP embed_cache_misses_total Total number of embedding queries with zero results.');
    lines.push('# TYPE embed_cache_misses_total counter');
    lines.push(`embed_cache_misses_total ${this.embedCacheMissesTotal}`);

    lines.push('# HELP ask_requests_total Total number of ask/generate requests by provider.');
    lines.push('# TYPE ask_requests_total counter');
    for (const [provider, count] of this.askRequestsByProvider.entries()) {
      lines.push(`ask_requests_total${labels({ provider })} ${count}`);
    }

    lines.push('# HELP ask_request_duration_seconds Total ask latency in seconds by provider.');
    lines.push('# TYPE ask_request_duration_seconds summary');
    for (const [provider, value] of this.askLatencyByProvider.entries()) {
      lines.push(`ask_request_duration_seconds_sum${labels({ provider })} ${value.sumSeconds.toFixed(6)}`);
      lines.push(`ask_request_duration_seconds_count${labels({ provider })} ${value.count}`);
    }

    return `${lines.join('\n')}\n`;
  }
}

export const metrics = new InMemoryMetrics();
