import type { OrchestrationService } from '../../modules/orchestration/service.js';

export async function renderHealthScreen(orchestration: OrchestrationService): Promise<string> {
  const providers = await orchestration.providersHealth();
  const lines = ['providers health:'];
  for (const p of providers) {
    lines.push(`- ${p.name.padEnd(18, ' ')} ${p.ok ? 'ok' : 'down'} ${p.latencyMs ? `${p.latencyMs}ms` : ''} ${p.error ?? ''}`);
  }
  return lines.join('\n');
}
