import { describe, expect, test } from 'vitest';
import { MCPObservability } from '../../src/mcp/observability.js';
import { MCPHealthMonitor } from '../../src/mcp/health-monitor.js';

describe('MCP observability + health monitor', () => {
  test('exports prometheus metrics', () => {
    const obs = new MCPObservability();
    obs.recordMetric('mcp_requests_total', 7, { provider: 'local-fallback' });
    const output = obs.exportPrometheus();

    expect(output).toContain('# HELP mcp_requests_total');
    expect(output).toContain('provider="local-fallback"');
  });

  test('health monitor provides recommendations for unhealthy checks', async () => {
    const monitor = new MCPHealthMonitor(() => ({ totalRoutings: 0 }), 'http://127.0.0.1:1/health');
    const report = await monitor.runHealthChecks();
    const recommendations = monitor.getRecommendations(report);

    expect(report.checks.length).toBe(4);
    expect(report.overall === 'degraded' || report.overall === 'unhealthy' || report.overall === 'healthy').toBe(true);
    expect(recommendations.some((r) => r.includes('Restart MCP server'))).toBe(true);
  });
});
