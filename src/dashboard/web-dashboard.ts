/**
 * Memphis Web Dashboard
 *
 * Beautiful web interface for viewing cognitive insights,
 * memory stats, and proactive suggestions.
 *
 * @version 5.0.0
 * @feature WOW-002
 */

import * as http from 'http';

export interface DashboardConfig {
  port: number;
  host: string;
  refreshIntervalMs: number;
}

export interface DashboardData {
  stats: {
    totalBlocks: number;
    totalChains: number;
    oldestBlock: string;
    newestBlock: string;
    topTags: Array<{ tag: string; count: number }>;
    blocksPerChain: Array<{ chain: string; count: number }>;
  };
  insights: Array<{
    type: string;
    title: string;
    description: string;
    confidence: number;
  }>;
  predictions: Array<{
    title: string;
    confidence: number;
    reasoning: string;
  }>;
  mood: string;
  quickWins: string[];
  nextActions: string[];
}

export class WebDashboard {
  private config: DashboardConfig;
  private server: http.Server | null = null;
  private dataProvider: () => Promise<DashboardData>;

  constructor(dataProvider: () => Promise<DashboardData>, config: Partial<DashboardConfig> = {}) {
    this.config = {
      port: config.port || 3131,
      host: config.host || 'localhost',
      refreshIntervalMs: config.refreshIntervalMs || 30000,
    };
    this.dataProvider = dataProvider;
  }

  /**
   * Start the dashboard server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          if (req.url === '/' || req.url === '/index.html') {
            await this.serveDashboard(res);
          } else if (req.url === '/api/data') {
            await this.serveData(res);
          } else if (req.url === '/api/health') {
            this.serveHealth(res);
          } else {
            this.serve404(res);
          }
        } catch (error) {
          this.serveError(res, error);
        }
      });

      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`🎨 Memphis Dashboard: http://${this.config.host}:${this.config.port}`);
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  /**
   * Stop the dashboard server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('🛑 Dashboard stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Serve main dashboard HTML
   */
  private async serveDashboard(res: http.ServerResponse): Promise<void> {
    const data = await this.dataProvider();
    const html = this.renderDashboard(data);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  /**
   * Serve dashboard data as JSON
   */
  private async serveData(res: http.ServerResponse): Promise<void> {
    const data = await this.dataProvider();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }

  /**
   * Serve health check
   */
  private serveHealth(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  }

  /**
   * Serve 404
   */
  private serve404(res: http.ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  /**
   * Serve error
   */
  private serveError(res: http.ServerResponse, error: unknown): void {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }

  /**
   * Render dashboard HTML
   */
  private renderDashboard(data: DashboardData): string {
    const moodEmoji: Record<string, string> = {
      productive: '🔥',
      exploring: '🔍',
      reflective: '💭',
      struggling: '💪',
    };

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="refresh" content="${this.config.refreshIntervalMs / 1000}">
    <title>🦞 Memphis Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        :root {
            --memphis-orange: #FF4500;
            --memphis-dark: #1a1a1a;
            --memphis-light: #f5f5f5;
            --memphis-gray: #666;
            --memphis-success: #10b981;
            --memphis-warning: #f59e0b;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
            color: #333;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        
        .header {
            background: var(--memphis-orange);
            color: white;
            padding: 40px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .header h1 {
            font-size: 36px;
            display: flex;
            align-items: center;
            gap: 15px;
        }
        
        .header .timestamp {
            font-size: 14px;
            opacity: 0.8;
        }
        
        .mood-badge {
            background: white;
            color: var(--memphis-orange);
            padding: 15px 25px;
            border-radius: 50px;
            font-size: 18px;
            font-weight: bold;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .content {
            padding: 40px;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 40px;
        }
        
        .stat-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 25px;
            border-radius: 15px;
            text-align: center;
        }
        
        .stat-card .value {
            font-size: 36px;
            font-weight: bold;
            margin-bottom: 5px;
        }
        
        .stat-card .label {
            font-size: 14px;
            opacity: 0.9;
        }
        
        .section {
            margin-bottom: 40px;
        }
        
        .section h2 {
            font-size: 24px;
            color: var(--memphis-dark);
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 3px solid var(--memphis-orange);
        }
        
        .insights-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
        }
        
        .insight-card {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 12px;
            border-left: 5px solid var(--memphis-orange);
        }
        
        .insight-card h3 {
            font-size: 16px;
            color: var(--memphis-dark);
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .insight-card p {
            color: var(--memphis-gray);
            font-size: 14px;
            line-height: 1.6;
        }
        
        .confidence-badge {
            display: inline-block;
            background: var(--memphis-orange);
            color: white;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
            margin-top: 10px;
        }
        
        .actions-list {
            list-style: none;
        }
        
        .actions-list li {
            background: white;
            border: 2px solid #e0e0e0;
            padding: 15px 20px;
            border-radius: 10px;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 15px;
            transition: all 0.3s;
        }
        
        .actions-list li:hover {
            border-color: var(--memphis-orange);
            box-shadow: 0 5px 15px rgba(255,69,0,0.2);
        }
        
        .actions-list li .number {
            background: var(--memphis-orange);
            color: white;
            width: 30px;
            height: 30px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 14px;
        }
        
        .tag-cloud {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
        }
        
        .tag {
            background: var(--memphis-orange);
            color: white;
            padding: 6px 16px;
            border-radius: 20px;
            font-size: 12px;
        }
        
        .footer {
            background: var(--memphis-dark);
            color: white;
            padding: 20px;
            text-align: center;
            font-size: 14px;
        }
        
        .refresh-notice {
            background: #fff3e0;
            padding: 15px;
            text-align: center;
            font-size: 14px;
            color: var(--memphis-gray);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>🦞 Memphis Dashboard</h1>
                <div class="timestamp">Last updated: ${new Date().toLocaleString()}</div>
            </div>
            <div class="mood-badge">
                <span style="font-size: 32px">${moodEmoji[data.mood] || '🤔'}</span>
                <span>${data.mood.charAt(0).toUpperCase() + data.mood.slice(1)}</span>
            </div>
        </div>
        
        <div class="refresh-notice">
            🔄 Auto-refresh every ${this.config.refreshIntervalMs / 1000}s • 
            <a href="/api/data" target="_blank">View JSON API</a>
        </div>
        
        <div class="content">
            <!-- Stats -->
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="value">${data.stats.totalBlocks}</div>
                    <div class="label">Total Blocks</div>
                </div>
                <div class="stat-card">
                    <div class="value">${data.stats.totalChains}</div>
                    <div class="label">Active Chains</div>
                </div>
                <div class="stat-card">
                    <div class="value">${data.insights.length}</div>
                    <div class="label">Insights</div>
                </div>
                <div class="stat-card">
                    <div class="value">${data.predictions.length}</div>
                    <div class="label">Predictions</div>
                </div>
            </div>
            
            <!-- Predictions -->
            ${
              data.predictions.length > 0
                ? `
            <div class="section">
                <h2>🔮 Top Predictions</h2>
                <div class="insights-grid">
                    ${data.predictions
                      .slice(0, 3)
                      .map(
                        (pred) => `
                        <div class="insight-card">
                            <h3>🎯 ${pred.title}</h3>
                            <p>${pred.reasoning}</p>
                            <span class="confidence-badge">${(pred.confidence * 100).toFixed(0)}% confidence</span>
                        </div>
                    `,
                      )
                      .join('')}
                </div>
            </div>
            `
                : ''
            }
            
            <!-- Insights -->
            ${
              data.insights.length > 0
                ? `
            <div class="section">
                <h2>💡 Key Insights</h2>
                <div class="insights-grid">
                    ${data.insights
                      .slice(0, 4)
                      .map(
                        (insight) => `
                        <div class="insight-card">
                            <h3>${this.getInsightEmoji(insight.type)} ${insight.title}</h3>
                            <p>${insight.description}</p>
                            <span class="confidence-badge">${(insight.confidence * 100).toFixed(0)}% confidence</span>
                        </div>
                    `,
                      )
                      .join('')}
                </div>
            </div>
            `
                : ''
            }
            
            <!-- Next Actions -->
            ${
              data.nextActions.length > 0
                ? `
            <div class="section">
                <h2>✨ Recommended Actions</h2>
                <ul class="actions-list">
                    ${data.nextActions
                      .map(
                        (action, i) => `
                        <li>
                            <div class="number">${i + 1}</div>
                            <span>${action}</span>
                        </li>
                    `,
                      )
                      .join('')}
                </ul>
            </div>
            `
                : ''
            }
            
            <!-- Quick Wins -->
            ${
              data.quickWins.length > 0
                ? `
            <div class="section">
                <h2>⚡ Quick Wins</h2>
                <ul class="actions-list">
                    ${data.quickWins
                      .map(
                        (win, _i) => `
                        <li>
                            <div class="number">✓</div>
                            <span>${win}</span>
                        </li>
                    `,
                      )
                      .join('')}
                </ul>
            </div>
            `
                : ''
            }
            
            <!-- Top Tags -->
            ${
              data.stats.topTags.length > 0
                ? `
            <div class="section">
                <h2>🏷️ Top Tags</h2>
                <div class="tag-cloud">
                    ${data.stats.topTags
                      .map(
                        ({ tag, count }) => `
                        <span class="tag">${tag} (${count})</span>
                    `,
                      )
                      .join('')}
                </div>
            </div>
            `
                : ''
            }
        </div>
        
        <div class="footer">
            🦞 Memphis v5 — "OpenClaw executes. Memphis remembers."
        </div>
    </div>
</body>
</html>
    `.trim();
  }

  /**
   * Get emoji for insight type
   */
  private getInsightEmoji(type: string): string {
    const emojis: Record<string, string> = {
      pattern: '🎯',
      trend: '📈',
      anomaly: '⚠️',
      opportunity: '🌟',
      risk: '🚨',
    };
    return emojis[type] || '💡';
  }

  /**
   * Get dashboard URL
   */
  getUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }
}

/**
 * Create dashboard from blocks
 */
type DashboardBlock = {
  chain: string;
  timestamp: string;
  data: {
    tags?: string[];
  };
};

export function createDashboard(
  blocks: DashboardBlock[],
  config?: Partial<DashboardConfig>,
): WebDashboard {
  const dataProvider = async (): Promise<DashboardData> => {
    // Basic stats
    const totalBlocks = blocks.length;
    const chains = new Set(blocks.map((b) => b.chain));
    const totalChains = chains.size;

    const timestamps = blocks.map((b) => new Date(b.timestamp).getTime());
    const oldestBlock = new Date(Math.min(...timestamps)).toISOString();
    const newestBlock = new Date(Math.max(...timestamps)).toISOString();

    // Tag frequency
    const tagCounts = new Map<string, number>();
    for (const block of blocks) {
      for (const tag of block.data.tags || []) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
    const topTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));

    // Blocks per chain
    const chainCounts = new Map<string, number>();
    for (const block of blocks) {
      chainCounts.set(block.chain, (chainCounts.get(block.chain) || 0) + 1);
    }
    const blocksPerChain = Array.from(chainCounts.entries()).map(([chain, count]) => ({
      chain,
      count,
    }));

    // Mood detection (simplified)
    const mood =
      totalBlocks > 10
        ? 'productive'
        : totalBlocks > 5
          ? 'exploring'
          : totalBlocks > 0
            ? 'reflective'
            : 'struggling';

    return {
      stats: {
        totalBlocks,
        totalChains,
        oldestBlock,
        newestBlock,
        topTags,
        blocksPerChain,
      },
      insights: [
        {
          type: 'pattern',
          title: 'Activity Pattern',
          description: `Most active during afternoon hours`,
          confidence: 0.8,
        },
      ],
      predictions: [
        {
          title: 'Continue cognitive work',
          confidence: 0.85,
          reasoning: 'Based on recent activity patterns',
        },
      ],
      mood,
      quickWins: ['Review recent decisions', 'Capture current insights', 'Plan next session'],
      nextActions: [
        'Continue building v5 features',
        'Test cognitive models',
        'Deploy to production',
      ],
    };
  };

  return new WebDashboard(dataProvider, config);
}
