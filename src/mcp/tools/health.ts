import { loadConfig } from '../../infra/config/env.js';
import { buildHealthPayload, type HealthPayload } from '../../infra/http/health.js';

export type MemphisHealthOutput = HealthPayload;

export async function runMemphisHealth(): Promise<MemphisHealthOutput> {
  const config = loadConfig();
  return buildHealthPayload(config);
}
