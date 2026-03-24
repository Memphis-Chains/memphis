import type { ProviderName } from '../../core/types.js';

export class ProviderPolicy {
  private readonly cooldownUntil = new Map<ProviderName, number>();

  constructor(private readonly cooldownMs: number) {}

  public isInCooldown(provider: ProviderName, now = Date.now()): boolean {
    const until = this.cooldownUntil.get(provider) ?? 0;
    return now < until;
  }

  public markFailure(provider: ProviderName, now = Date.now()): void {
    this.cooldownUntil.set(provider, now + this.cooldownMs);
  }

  public markSuccess(provider: ProviderName): void {
    this.cooldownUntil.delete(provider);
  }

  public remainingCooldownMs(provider: ProviderName, now = Date.now()): number {
    const until = this.cooldownUntil.get(provider) ?? 0;
    return Math.max(0, until - now);
  }

  /**
   * Returns a snapshot of all providers currently in cooldown.
   * Used by doctor-v2 Tier A (Architecture Health) checks.
   */
  public getCooldownMap(): ReadonlyMap<ProviderName, number> {
    return this.cooldownUntil;
  }
}
