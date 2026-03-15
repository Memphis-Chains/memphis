import { spawnSync } from 'node:child_process';

import { emergencyFallbackTag, writeEmergencyLog } from './emergency-log.js';
import { appendBlock } from '../storage/chain-adapter.js';

export interface SecurityCriticalEvent {
  event: string;
  reason: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
  details?: Record<string, unknown>;
}

export interface SecurityCriticalWriteResult {
  wroteChain: boolean;
  wroteSyslog: boolean;
  wroteEmergency: boolean;
}

function writeSyslog(event: SecurityCriticalEvent): boolean {
  const message = `[memphis-security] ${event.event}: ${event.reason}`;
  try {
    const out = spawnSync('logger', ['-p', 'user.crit', message], {
      stdio: 'ignore',
      timeout: 1500,
    });
    return out.status === 0;
  } catch {
    return false;
  }
}

export async function writeSecurityCriticalEvent(
  event: SecurityCriticalEvent,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<SecurityCriticalWriteResult> {
  let wroteChain = false;
  let wroteSyslog = false;
  let wroteEmergency = false;

  try {
    await appendBlock(
      'system',
      {
        type: 'system',
        content: `${event.event}: ${event.reason}`,
        tags: ['security', 'critical', event.severity ?? 'critical'],
        event: event.event,
        reason: event.reason,
        details: event.details ?? {},
      },
      rawEnv,
    );
    wroteChain = true;
  } catch {
    wroteChain = false;
  }

  if (!wroteChain) {
    wroteSyslog = writeSyslog(event);
  }

  if (!wroteChain && !wroteSyslog) {
    const line = emergencyFallbackTag(
      `${event.event}: ${event.reason} details=${JSON.stringify(event.details ?? {})}`,
    );
    wroteEmergency = writeEmergencyLog(line, rawEnv) !== null;
  }

  return { wroteChain, wroteSyslog, wroteEmergency };
}
