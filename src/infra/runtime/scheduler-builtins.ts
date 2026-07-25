import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import { startScheduledBackupLoop } from './scheduled-backup.js';
import { getConfigPath, getDataDir } from '../../config/paths.js';
import { sendTelegramMessage } from '../../gateway/channels/telegram-send.js';
import { runMemphisSloStatus } from '../../mcp/tools/slo-status.js';
import { runDoctorChecksV2 } from '../cli/utils/doctor-v2.js';
import { loadConfig } from '../config/env.js';
import { buildHealthPayload } from '../http/health.js';

export type BuiltinSchedulerJob =
  | 'runtime-watch'
  | 'scheduled-backup'
  | 'doctor-diagnose'
  | 'operator-briefing'
  | 'attachment-retention';

export type BuiltinJobResult = {
  success: boolean;
  skipped?: boolean;
  output: string;
  error?: string;
};

function telegramRecipient(rawEnv: NodeJS.ProcessEnv): string | undefined {
  return (
    rawEnv.MEMPHIS_TELEGRAM_ALLOWED_USER_IDS?.split(',')
      .map((value) => value.trim())
      .find(Boolean) ?? rawEnv.MEMPHIS_TELEGRAM_CHAT_ID?.trim()
  );
}

async function notify(message: string, rawEnv: NodeJS.ProcessEnv): Promise<BuiltinJobResult> {
  const chatId = telegramRecipient(rawEnv);
  if (!chatId) {
    return {
      success: true,
      skipped: true,
      output: 'Telegram delivery skipped: no configured allowlist recipient',
    };
  }
  const result = await sendTelegramMessage({ message, chatId, rawEnv });
  return result.ok
    ? { success: true, output: `Telegram message sent to ${chatId}` }
    : { success: false, output: result.error ?? 'Telegram delivery failed', error: result.error };
}

async function runtimeWatch(rawEnv: NodeJS.ProcessEnv): Promise<BuiltinJobResult> {
  const health = await buildHealthPayload(loadConfig(rawEnv), rawEnv);
  const slo = runMemphisSloStatus({ windowDays: 7 }, rawEnv);
  const failures = [
    ...(health.status === 'healthy' ? [] : [`health=${health.status}`]),
    ...slo.failingSlos.map((name) => `slo=${name}`),
  ];
  const statePath = join(getConfigPath('scheduler'), 'runtime-watch-state.json');
  let prior: { failureKey?: string; lastAlertAt?: string } = {};
  try {
    prior = JSON.parse(readFileSync(statePath, 'utf8')) as typeof prior;
  } catch {
    // First run has no transition state.
  }
  if (failures.length === 0) {
    if (prior.failureKey) {
      await notify(`Memphis runtime watch recovered from: ${prior.failureKey}`, rawEnv);
    }
    mkdirSync(join(getConfigPath('scheduler')), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify({}, null, 2)}\n`, { mode: 0o600 });
    return { success: true, output: 'Runtime health and SLO checks pass' };
  }
  const message = `Memphis runtime watch: ${failures.join(', ')}`;
  const failureKey = [...failures].sort().join('|');
  const lastAlertMs = prior.lastAlertAt ? Date.parse(prior.lastAlertAt) : 0;
  const alertDue =
    prior.failureKey !== failureKey ||
    !Number.isFinite(lastAlertMs) ||
    Date.now() - lastAlertMs >= 6 * 60 * 60 * 1000;
  const delivery = alertDue
    ? await notify(message, rawEnv)
    : { success: true, skipped: true, output: 'duplicate alert suppressed' };
  mkdirSync(join(getConfigPath('scheduler')), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        failureKey,
        lastAlertAt: alertDue ? new Date().toISOString() : prior.lastAlertAt,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return {
    success: false,
    output: `${message}; ${delivery.output}`,
    error: message,
  };
}

async function scheduledBackup(rawEnv: NodeJS.ProcessEnv): Promise<BuiltinJobResult> {
  const backupEnv = { ...rawEnv };
  delete backupEnv.MEMPHIS_BACKUP_INTERVAL_MS;
  const handle = startScheduledBackupLoop({ rawEnv: backupEnv });
  const state = await handle.tickNow();
  handle.stop();
  if (state.lastError) {
    return { success: false, output: state.lastError, error: state.lastError };
  }
  return {
    success: true,
    output: `Backup created: ${state.lastSuccessFile ?? 'unknown'}; drill=${
      state.lastDrillOk === undefined ? 'not-due' : state.lastDrillOk ? 'pass' : 'fail'
    }`,
  };
}

async function doctorDiagnose(): Promise<BuiltinJobResult> {
  const report = await runDoctorChecksV2();
  const output = `Doctor: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail}; ${report.recommendedAction}`;
  return {
    success: report.ok,
    output,
    error: report.ok ? undefined : output,
  };
}

async function operatorBriefing(rawEnv: NodeJS.ProcessEnv): Promise<BuiltinJobResult> {
  const health = await buildHealthPayload(loadConfig(rawEnv), rawEnv);
  const slo = runMemphisSloStatus({ windowDays: 7 }, rawEnv);
  const scheduler = health.scheduler;
  const report = [
    `Memphis — raport poranny ${new Date().toLocaleString('pl-PL', {
      timeZone: 'Europe/Warsaw',
    })}`,
    '',
    `System: ${health.status}`,
    `Recall: ${health.runtime.memory.recallMode}`,
    `Pamięć exact: ${health.runtime.exactSearch.entries} wpisów`,
    `Scheduler: ${scheduler?.tasks.enabled ?? 0} aktywnych, ${scheduler?.tasks.overdue ?? 0} opóźnionych`,
    `SLO 7d: ${slo.allSlosPassing ? 'OK' : `FAIL (${slo.failingSlos.join(', ')})`}`,
    `Backup: ${health.backups?.lastSuccessFile ?? 'brak'}`,
  ].join('\n');
  const delivery = await notify(report, rawEnv);
  return delivery.skipped
    ? { success: true, skipped: true, output: `${delivery.output}\n${report}` }
    : { ...delivery, output: `${delivery.output}\n${report}` };
}

export function pruneTelegramAttachments(
  options: {
    rawEnv?: NodeJS.ProcessEnv;
    apply?: boolean;
    nowMs?: number;
  } = {},
): {
  quarantined: string[];
  purged: string[];
  wouldQuarantine: string[];
  wouldPurge: string[];
} {
  const rawEnv = options.rawEnv ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const dataDir = getDataDir(rawEnv);
  const sourceDir = join(dataDir, 'state', 'telegram-attachments');
  const quarantineDir = join(dataDir, 'state', 'quarantine', 'telegram-attachments');
  const result = {
    quarantined: [] as string[],
    purged: [] as string[],
    wouldQuarantine: [] as string[],
    wouldPurge: [] as string[],
  };
  const olderThan = (path: string, days: number): boolean =>
    nowMs - statSync(path).mtimeMs > days * 24 * 60 * 60 * 1000;

  if (existsSync(sourceDir)) {
    for (const name of readdirSync(sourceDir)) {
      const path = join(sourceDir, name);
      if (!statSync(path).isFile() || !olderThan(path, 7)) continue;
      result.wouldQuarantine.push(path);
      if (options.apply) {
        mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
        const destination = join(quarantineDir, `${Date.now()}-${basename(path)}`);
        renameSync(path, destination);
        result.quarantined.push(destination);
      }
    }
  }
  if (existsSync(quarantineDir)) {
    for (const name of readdirSync(quarantineDir)) {
      const path = join(quarantineDir, name);
      if (!statSync(path).isFile() || !olderThan(path, 30)) continue;
      result.wouldPurge.push(path);
      if (options.apply) {
        rmSync(path);
        result.purged.push(path);
      }
    }
  }
  return result;
}

async function attachmentRetention(rawEnv: NodeJS.ProcessEnv): Promise<BuiltinJobResult> {
  const result = pruneTelegramAttachments({ rawEnv, apply: true });
  return {
    success: true,
    output: `Attachments: quarantined=${result.quarantined.length}, purged=${result.purged.length}`,
  };
}

export async function executeBuiltinSchedulerJob(
  job: BuiltinSchedulerJob,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<BuiltinJobResult> {
  switch (job) {
    case 'runtime-watch':
      return runtimeWatch(rawEnv);
    case 'scheduled-backup':
      return scheduledBackup(rawEnv);
    case 'doctor-diagnose':
      return doctorDiagnose();
    case 'operator-briefing':
      return operatorBriefing(rawEnv);
    case 'attachment-retention':
      return attachmentRetention(rawEnv);
  }
}
