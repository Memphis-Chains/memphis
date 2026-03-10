export interface Metric {
  name: string;
  value: number;
  timestamp: number;
  tags: Record<string, string>;
}

export interface AggregatedMetric {
  name: string;
  count: number;
  avg: number;
  min: number;
  max: number;
}

export class MCPObservability {
  private metrics: Metric[] = [];
  private maxMetrics = 1000;

  recordMetric(name: string, value: number, tags: Record<string, string> = {}): void {
    this.metrics.push({ name, value, timestamp: Date.now(), tags });
    if (this.metrics.length > this.maxMetrics) this.metrics = this.metrics.slice(-this.maxMetrics);
  }

  getMetrics(name?: string): Metric[] {
    return name ? this.metrics.filter((m) => m.name === name) : [...this.metrics];
  }

  getAggregatedMetrics(name: string, windowMs = 60000): AggregatedMetric {
    const cutoff = Date.now() - windowMs;
    const relevant = this.metrics.filter((m) => m.name === name && m.timestamp >= cutoff);
    if (relevant.length === 0) return { name, count: 0, avg: 0, min: 0, max: 0 };
    const values = relevant.map((m) => m.value);
    return {
      name,
      count: values.length,
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }

  exportPrometheus(): string {
    const grouped = new Map<string, Metric[]>();
    for (const m of this.metrics) {
      if (!grouped.has(m.name)) grouped.set(m.name, []);
      grouped.get(m.name)!.push(m);
    }

    const lines: string[] = [];
    for (const [name, metrics] of grouped.entries()) {
      const latest = metrics[metrics.length - 1];
      const tagParts = Object.entries(latest.tags).map(([k, v]) => `${k}="${v}"`);
      const labels = tagParts.length > 0 ? `{${tagParts.join(',')}}` : '';
      lines.push(`# HELP ${name} Memphis MCP metric`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name}${labels} ${latest.value}`);
    }
    return lines.join('\n');
  }
}
