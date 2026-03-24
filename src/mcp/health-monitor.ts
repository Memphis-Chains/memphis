import { getChainAdapterStatus, verifyChainIntegrity } from '../infra/storage/chain-adapter.js';
import { NapiChainAdapter } from '../infra/storage/rust-chain-adapter.js';

export interface HealthCheck {
  name: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  message: string;
  latency?: number;
  details?: unknown;
}

export interface HealthReport {
  timestamp: string;
  overall: 'healthy' | 'degraded' | 'unhealthy';
  checks: HealthCheck[];
}

export class MCPHealthMonitor {
  private checks: HealthCheck[] = [];
  private lastCheck: Date | null = null;

  constructor(
    private readonly providerStats: () => { totalRoutings: number } = () => ({ totalRoutings: 0 }),
    private readonly healthUrl = 'http://localhost:3000/health',
  ) {}

  async runHealthChecks(): Promise<HealthReport> {
    this.checks = [];
    this.lastCheck = new Date();
    this.checks.push(await this.checkServerAvailability());
    this.checks.push(await this.checkBridgeConnectivity());
    this.checks.push(await this.checkChainIntegrity());
    this.checks.push(await this.checkProviderHealth());

    const overall = this.checks.every((c) => c.status === 'healthy')
      ? 'healthy'
      : this.checks.some((c) => c.status === 'unhealthy')
        ? 'unhealthy'
        : 'degraded';

    return { timestamp: this.lastCheck.toISOString(), overall, checks: this.checks };
  }

  private async checkServerAvailability(): Promise<HealthCheck> {
    const started = Date.now();
    try {
      const response = await fetch(this.healthUrl, { signal: AbortSignal.timeout(2000) });
      if (!response.ok)
        return {
          name: 'server',
          status: 'unhealthy',
          message: `Server returned ${response.status}`,
        };
      return {
        name: 'server',
        status: 'healthy',
        message: 'MCP server responding',
        latency: Date.now() - started,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { name: 'server', status: 'unhealthy', message: `Server unreachable: ${message}` };
    }
  }

  private async checkBridgeConnectivity(): Promise<HealthCheck> {
    const started = Date.now();
    try {
      const status = getChainAdapterStatus();
      if (!status.rustBridgeLoaded) {
        return {
          name: 'bridge',
          status: 'unhealthy',
          message: 'Rust NAPI bridge not loaded',
          details: { rustBridgeLoaded: false, backend: status.backend },
        };
      }

      // Verify bridge is actually callable by attempting a lightweight query
      const adapter = new NapiChainAdapter();
      await adapter.getRecentBlocks('journal', 1);

      return {
        name: 'bridge',
        status: 'healthy',
        message: 'Rust NAPI bridge responding',
        latency: Date.now() - started,
        details: { rustBridgeLoaded: true, backend: status.backend },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { name: 'bridge', status: 'unhealthy', message: `Bridge check failed: ${message}` };
    }
  }

  private async checkChainIntegrity(): Promise<HealthCheck> {
    const started = Date.now();
    try {
      const verification = await verifyChainIntegrity();
      return {
        name: 'chain',
        status: verification.ok ? 'healthy' : 'unhealthy',
        message: verification.ok
          ? `Chain integrity OK (${verification.chainsChecked} chains, ${verification.blockCount} blocks)`
          : 'Chain integrity check failed',
        latency: Date.now() - started,
        details: {
          chainsChecked: verification.chainsChecked,
          blockCount: verification.blockCount,
          chain: verification.chain,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        name: 'chain',
        status: 'unhealthy',
        message: `Chain verification failed: ${message}`,
      };
    }
  }

  private async checkProviderHealth(): Promise<HealthCheck> {
    const stats = this.providerStats();
    return {
      name: 'providers',
      status: stats.totalRoutings > 0 ? 'healthy' : 'unknown',
      message: `${stats.totalRoutings} routings performed`,
      details: stats,
    };
  }

  getRecommendations(report: HealthReport): string[] {
    const recommendations: string[] = [];
    for (const check of report.checks) {
      if (check.status !== 'unhealthy') continue;
      if (check.name === 'server') recommendations.push('Restart MCP server: memphis mcp serve');
      if (check.name === 'bridge') recommendations.push('Rebuild bridge: npm run build:rust');
      if (check.name === 'chain') recommendations.push('Repair chain: memphis repair --auto');
      if (check.name === 'providers')
        recommendations.push('Check provider configuration: memphis provider list');
    }
    return recommendations;
  }
}
