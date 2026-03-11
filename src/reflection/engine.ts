import type { Reflection, ReflectionOptions, ReflectionTrigger, ReflectionType } from './types.js';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const ALL_TYPES: ReflectionType[] = [
  'performance',
  'pattern',
  'failure',
  'success',
  'alignment',
  'evolution',
];

export class ReflectionEngine {
  private reflections: Reflection[] = [];

  async reflectDaily(
    trigger: ReflectionTrigger = 'scheduled',
    context: Map<string, unknown> = new Map(),
    options: ReflectionOptions = {},
  ): Promise<Reflection[]> {
    const now = options.now ?? new Date();
    const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;

    const start = Date.now();
    const recent = this.getRecentReflections(now, windowMs);

    const created = ALL_TYPES.map((type) => {
      const analysis = this.analyze(type, recent, context);
      const reflection: Reflection = {
        id: this.generateId(type),
        type,
        trigger,
        subject: this.getSubject(type),
        context,
        findings: analysis.findings,
        insights: analysis.insights,
        recommendations: analysis.recommendations,
        confidence: this.calculateConfidence(analysis.findings, analysis.insights),
        impact: analysis.impact,
        timestamp: now,
        duration: Date.now() - start,
      };

      this.reflections.push(reflection);
      return reflection;
    });

    this.trimHistory();
    return created;
  }

  getReflections(): Reflection[] {
    return [...this.reflections];
  }

  private analyze(
    type: ReflectionType,
    recent: Reflection[],
    context: Map<string, unknown>,
  ): { findings: string[]; insights: string[]; recommendations: string[]; impact: number } {
    const score = this.readNumber(context, 'score', 0.5);
    const goal = this.readNumber(context, 'goal', 0.7);
    const failures = this.readNumber(context, 'failures', 0);
    const successes = this.readNumber(context, 'successes', 0);

    if (type === 'performance') {
      const findings = [
        `Window size: ${recent.length} reflections`,
        `Current score: ${score.toFixed(2)}`,
      ];
      const insights = [score >= goal ? 'Performance meets target' : 'Performance below target'];
      const recommendations =
        score >= goal
          ? ['Preserve current operating baseline']
          : ['Increase focus on high-signal decisions'];
      return { findings, insights, recommendations, impact: this.clamp(score - 0.5, -1, 1) };
    }

    if (type === 'pattern') {
      const dominant = this.findDominantType(recent);
      return {
        findings: [
          dominant ? `Dominant recent type: ${dominant}` : 'No dominant pattern in last 24h',
        ],
        insights: [
          dominant
            ? `Behavior clusters around ${dominant}`
            : 'Need more samples for stable patterns',
        ],
        recommendations: [
          dominant ? `Diversify beyond ${dominant} checks` : 'Collect more reflection samples',
        ],
        impact: dominant ? 0.2 : 0,
      };
    }

    if (type === 'failure') {
      const failureRate = failures + successes > 0 ? failures / (failures + successes) : 0;
      return {
        findings: [`Failures observed: ${failures}`],
        insights: [failureRate > 0.4 ? 'Failure rate is elevated' : 'Failure rate is controlled'],
        recommendations: [
          failureRate > 0.4
            ? 'Review failed decisions from last 24h'
            : 'Keep current failure triage cadence',
        ],
        impact: this.clamp(0.3 - failureRate, -1, 1),
      };
    }

    if (type === 'success') {
      const successRate = failures + successes > 0 ? successes / (failures + successes) : 0;
      return {
        findings: [`Successes observed: ${successes}`],
        insights: [
          successRate >= 0.6 ? 'Success momentum is positive' : 'Success momentum is weak',
        ],
        recommendations: [
          successRate >= 0.6
            ? 'Scale recently successful tactics'
            : 'Reinforce one proven tactic this cycle',
        ],
        impact: this.clamp(successRate - 0.3, -1, 1),
      };
    }

    if (type === 'alignment') {
      const gap = goal - score;
      return {
        findings: [`Goal: ${goal.toFixed(2)}`, `Gap: ${gap.toFixed(2)}`],
        insights: [gap <= 0 ? 'Execution aligned with goal' : 'Execution drift detected'],
        recommendations: [
          gap <= 0 ? 'Maintain current priorities' : 'Realign top tasks to goal criteria',
        ],
        impact: this.clamp(-gap, -1, 1),
      };
    }

    const confidenceTrend =
      recent.length > 0
        ? recent.reduce((sum, item) => sum + item.confidence, 0) / recent.length
        : 0.5;

    return {
      findings: [`Average confidence in window: ${confidenceTrend.toFixed(2)}`],
      insights: [
        confidenceTrend >= 0.6
          ? 'Capability appears to evolve positively'
          : 'Evolution trend is flat',
      ],
      recommendations: [
        confidenceTrend >= 0.6
          ? 'Keep incremental improvements'
          : 'Run one focused improvement experiment',
      ],
      impact: this.clamp(confidenceTrend - 0.5, -1, 1),
    };
  }

  private calculateConfidence(findings: string[], insights: string[]): number {
    const value =
      0.35 + Math.min(findings.length * 0.1, 0.3) + Math.min(insights.length * 0.15, 0.35);
    return this.clamp(value, 0, 1);
  }

  private getRecentReflections(now: Date, windowMs: number): Reflection[] {
    const minTime = now.getTime() - windowMs;
    return this.reflections.filter((item) => item.timestamp.getTime() >= minTime);
  }

  private findDominantType(reflections: Reflection[]): ReflectionType | null {
    if (reflections.length === 0) {
      return null;
    }

    const counts = new Map<ReflectionType, number>();
    for (const reflection of reflections) {
      counts.set(reflection.type, (counts.get(reflection.type) ?? 0) + 1);
    }

    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }

  private readNumber(context: Map<string, unknown>, key: string, fallback: number): number {
    const value = context.get(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private trimHistory(maxEntries = 500): void {
    if (this.reflections.length > maxEntries) {
      this.reflections = this.reflections.slice(-maxEntries);
    }
  }

  private generateId(type: ReflectionType): string {
    return `reflection_${type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private getSubject(type: ReflectionType): string {
    const mapping: Record<ReflectionType, string> = {
      performance: 'Daily performance review',
      pattern: 'Daily behavior pattern review',
      failure: 'Daily failure review',
      success: 'Daily success review',
      alignment: 'Daily goal alignment review',
      evolution: 'Daily evolution review',
    };

    return mapping[type];
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
