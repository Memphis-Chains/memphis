import type { OrchestrationService } from '../../modules/orchestration/service.js';
import {
  BOLD,
  FG_COPPER_BRIGHT,
  FG_OXIDE,
  FG_STEEL,
  FG_TEAL,
  FG_WARM,
  RESET,
  statusDot,
} from '../theme.js';

export async function renderHealthScreen(orchestration: OrchestrationService): Promise<string> {
  const providers = await orchestration.providersHealth();
  const lines = [`${FG_COPPER_BRIGHT}${BOLD}Provider Health${RESET}`];
  for (const p of providers) {
    const dot = statusDot(p.ok);
    const name = `${FG_WARM}${p.name.padEnd(18)}${RESET}`;
    const status = p.ok ? `${FG_TEAL}ok${RESET}` : `${FG_OXIDE}down${RESET}`;
    const latency = p.latencyMs ? `${FG_STEEL}${p.latencyMs}ms${RESET}` : '';
    const error = p.error ? `${FG_OXIDE}${p.error}${RESET}` : '';
    lines.push(`  ${dot} ${name} ${status} ${latency} ${error}`);
  }
  return lines.join('\n');
}
