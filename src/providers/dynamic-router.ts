import { CapabilityMatrix, ProviderCapabilities } from './capability-matrix.js';

export interface RoutingContext {
  taskType: 'chat' | 'code' | 'analysis' | 'creative';
  priority: 'latency' | 'cost' | 'quality';
  requirements: {
    minContextWindow?: number;
    needsVision?: boolean;
    needsFunctionCalling?: boolean;
  };
}

type ModelSelection = { name: string; contextWindow: number };

export class DynamicRouter {
  private readonly capabilityMatrix: CapabilityMatrix;
  private readonly usageTracker: UsageTracker;

  constructor() {
    this.capabilityMatrix = new CapabilityMatrix();
    this.usageTracker = new UsageTracker();
  }

  route(context: RoutingContext): { provider: string; model: string; reason: string } {
    const candidates = this.capabilityMatrix
      .getAllProviders()
      .filter((provider) => this.meetsRequirements(provider, context.requirements));

    if (candidates.length === 0) {
      return {
        provider: 'openai-compatible',
        model: 'gpt-4',
        reason: 'No providers meet requirements, using fallback',
      };
    }

    const selected = this.pickBestProvider(candidates, context.priority);
    const model = this.selectBestModel(selected, context);
    this.usageTracker.recordRouting(selected.name, model.name, context);

    return {
      provider: selected.name,
      model: model.name,
      reason: `Selected for ${context.priority} optimization`,
    };
  }

  private meetsRequirements(
    provider: ProviderCapabilities,
    requirements: RoutingContext['requirements'],
  ): boolean {
    if (requirements.minContextWindow) {
      const hasModel = provider.models.some(
        (model) => model.contextWindow >= requirements.minContextWindow!,
      );
      if (!hasModel) return false;
    }

    if (requirements.needsVision) {
      const hasVision = provider.models.some((model) => model.supportsVision);
      if (!hasVision) return false;
    }

    if (requirements.needsFunctionCalling) {
      const hasFunctions = provider.models.some((model) => model.supportsFunctionCalling);
      if (!hasFunctions) return false;
    }

    return true;
  }

  private selectBestModel(provider: ProviderCapabilities, context: RoutingContext): ModelSelection {
    let models = provider.models.filter((model) => {
      if (
        context.requirements.minContextWindow &&
        model.contextWindow < context.requirements.minContextWindow
      ) {
        return false;
      }
      if (context.requirements.needsVision && !model.supportsVision) {
        return false;
      }
      if (context.requirements.needsFunctionCalling && !model.supportsFunctionCalling) {
        return false;
      }
      return true;
    });

    if (models.length === 0) {
      models = provider.models;
    }

    switch (context.priority) {
      case 'quality':
        return this.pickLargestContextModel(models);
      case 'latency':
      case 'cost':
      default:
        return models[0]!;
    }
  }

  private pickBestProvider(
    candidates: ProviderCapabilities[],
    priority: RoutingContext['priority'],
  ): ProviderCapabilities {
    let best = candidates[0]!;
    switch (priority) {
      case 'latency':
        for (let i = 1; i < candidates.length; i += 1) {
          if (candidates[i]!.reliability.avgLatency < best.reliability.avgLatency) {
            best = candidates[i]!;
          }
        }
        return best;
      case 'cost':
        {
          let bestCost = best.pricing.inputCostPer1k + best.pricing.outputCostPer1k;
          for (let i = 1; i < candidates.length; i += 1) {
            const candidate = candidates[i]!;
            const cost = candidate.pricing.inputCostPer1k + candidate.pricing.outputCostPer1k;
            if (cost < bestCost) {
              best = candidate;
              bestCost = cost;
            }
          }
        }
        return best;
      case 'quality':
      default:
        for (let i = 1; i < candidates.length; i += 1) {
          if (candidates[i]!.reliability.uptimePercent > best.reliability.uptimePercent) {
            best = candidates[i]!;
          }
        }
        return best;
    }
  }

  private pickLargestContextModel(models: ModelSelection[]): ModelSelection {
    let best = models[0]!;
    for (let i = 1; i < models.length; i += 1) {
      if (models[i]!.contextWindow > best.contextWindow) {
        best = models[i]!;
      }
    }
    return best;
  }

  getRoutingStats(): {
    totalRoutings: number;
    providerCounts: Record<string, number>;
    modelCounts: Record<string, number>;
  } {
    return this.usageTracker.getStats();
  }
}

class UsageTracker {
  private readonly routings: Array<{
    provider: string;
    model: string;
    context: RoutingContext;
    timestamp: Date;
  }> = [];

  recordRouting(provider: string, model: string, context: RoutingContext): void {
    this.routings.push({ provider, model, context, timestamp: new Date() });
  }

  getStats(): {
    totalRoutings: number;
    providerCounts: Record<string, number>;
    modelCounts: Record<string, number>;
  } {
    const providerCounts: Record<string, number> = {};
    const modelCounts: Record<string, number> = {};

    for (const routing of this.routings) {
      providerCounts[routing.provider] = (providerCounts[routing.provider] ?? 0) + 1;
      modelCounts[`${routing.provider}/${routing.model}`] =
        (modelCounts[`${routing.provider}/${routing.model}`] ?? 0) + 1;
    }

    return {
      totalRoutings: this.routings.length,
      providerCounts,
      modelCounts,
    };
  }
}
