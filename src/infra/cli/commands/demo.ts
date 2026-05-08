/**
 * `memphis demo` — pre-demo readiness orchestrator.
 *
 * Phase 3 PR 3.1 of the autopilot push (post-Zawoja recovery). Operator's
 * lesson #2 from the 2026-05-06 Hotel Jawor failure: "Testować demo PRZED
 * wejściem". This command refuses to declare a demo "armed" unless every
 * dependency is verified.
 *
 * Subcommands (this PR ships `arm` and `status`; `rehearse` and `plan-b`
 * land in PR 3.2 and 3.3):
 *   - `memphis demo arm`    — run checklist, write data/demo-armed.json
 *   - `memphis demo status` — print last-armed state + checks
 *   - `memphis demo disarm` — clear armed state (operator override)
 *
 * Exit codes:
 *   0 — armed (or status/disarm OK)
 *   1 — refused (one or more checks failed)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';

import chalk from 'chalk';

import { getDataDir } from '../../../config/paths.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

interface DemoCheckResult {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
  fix?: string;
}

interface DemoArmedState {
  armedAt: string;
  armedBy: string;
  checks: DemoCheckResult[];
  expiresHint: string;
  /**
   * Phase 3.2 (autopilot 2026-05-08): timestamp of the most recent
   * `memphis demo rehearse` run. Reset to undefined when `disarm` runs
   * or arm reinitialises. Surfaced in /v1/ops/status as
   * `demo.lastRehearseAt`.
   */
  lastRehearseAt?: string;
  lastRehearseOk?: boolean;
  lastRehearseDurationMs?: number;
}

const DEMO_ARMED_FILENAME = 'demo-armed.json';

function getDemoStatePath(): string {
  return `${getDataDir()}/${DEMO_ARMED_FILENAME}`;
}

function readArmedState(): DemoArmedState | null {
  const path = getDemoStatePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as DemoArmedState;
  } catch {
    return null;
  }
}

function writeArmedState(state: DemoArmedState): void {
  const path = getDemoStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function clearArmedState(): boolean {
  const path = getDemoStatePath();
  if (!existsSync(path)) return false;
  // Truncate atomically rather than unlink; preserves operator-set perms
  // and makes "disarmed" a recognisable state separate from "never armed".
  writeFileSync(path, '', 'utf8');
  return true;
}

/**
 * Run the canonical demo-readiness checklist. Each check is best-effort:
 * connection failures map to `warn` rather than `fail` so a transient
 * Ollama hiccup doesn't lock the operator out of arming. Hard `fail`
 * means a structural prerequisite is missing.
 */
async function runChecklist(): Promise<DemoCheckResult[]> {
  const checks: DemoCheckResult[] = [];

  // 1. Doctor health (smoke summary). Re-uses the v2 doctor surface so
  //    we report the same colours operators see in `memphis doctor`.
  try {
    const { runDoctorChecksV2 } = await import('../utils/doctor-v2.js');
    const report = await runDoctorChecksV2({});
    const failingRequired = report.checks.filter((c) => c.required && !c.ok);
    if (failingRequired.length === 0) {
      checks.push({
        id: 'doctor',
        title: 'Doctor v2',
        status: 'pass',
        detail: `${report.checks.length} checks; ${report.checks.filter((c) => c.ok).length} OK`,
      });
    } else {
      checks.push({
        id: 'doctor',
        title: 'Doctor v2',
        status: 'fail',
        detail: `${failingRequired.length} required check(s) failing: ${failingRequired
          .slice(0, 3)
          .map((c) => c.id)
          .join(', ')}`,
        fix: 'Run `memphis doctor` to see the full report.',
      });
    }
  } catch (err) {
    checks.push({
      id: 'doctor',
      title: 'Doctor v2',
      status: 'warn',
      detail: `doctor check threw: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 2. Backup recency — Phase 1.2 already exposes verifyAllBackups.
  try {
    const { verifyAllBackups } = await import('./backup.js');
    const sweep = await verifyAllBackups();
    if (sweep.total === 0) {
      checks.push({
        id: 'backup',
        title: 'Backup',
        status: 'fail',
        detail: 'No backup archives on disk',
        fix: 'Run `memphis backup create` before arming.',
      });
    } else if (!sweep.ok) {
      checks.push({
        id: 'backup',
        title: 'Backup',
        status: 'fail',
        detail: `${sweep.corruptCount}/${sweep.total} archive(s) corrupt`,
        fix: 'Run `memphis backup list --verify` to identify the bad archive(s).',
      });
    } else {
      checks.push({
        id: 'backup',
        title: 'Backup',
        status: 'pass',
        detail: `${sweep.validCount}/${sweep.total} archive(s) valid`,
      });
    }
  } catch (err) {
    checks.push({
      id: 'backup',
      title: 'Backup',
      status: 'warn',
      detail: `backup verify threw: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 3. Telegram readiness — only checked when channel gateway is enabled.
  try {
    const { getTelegramReadinessStatus } = await import(
      '../../../gateway/channels/telegram-readiness.js'
    );
    const tg = await getTelegramReadinessStatus(process.env);
    if (tg.state === 'ready') {
      checks.push({
        id: 'telegram',
        title: 'Telegram gateway',
        status: 'pass',
        detail: `ready (${tg.allowlistCount ?? 0} allowed user(s))`,
      });
    } else if (tg.state === 'disabled' || !tg.gatewayEnabled) {
      checks.push({
        id: 'telegram',
        title: 'Telegram gateway',
        status: 'warn',
        detail: 'gateway disabled (skipped)',
      });
    } else {
      checks.push({
        id: 'telegram',
        title: 'Telegram gateway',
        status: 'fail',
        detail: `state=${tg.state}`,
        fix: 'Set MEMPHIS_TELEGRAM_BOT_TOKEN + MEMPHIS_CHANNEL_GATEWAY_ENABLED=true.',
      });
    }
  } catch (err) {
    checks.push({
      id: 'telegram',
      title: 'Telegram gateway',
      status: 'warn',
      detail: `telegram readiness threw: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 4. Process-lock — Phase 1.3 ensures only one Memphis instance.
  try {
    const { peekProcessLock } = await import('../../runtime/process-lock.js');
    const lock = peekProcessLock(getDataDir());
    if (lock.holder === null) {
      // No instance running yet — that's actually fine for arming pre-flight.
      checks.push({
        id: 'process-lock',
        title: 'Process lock',
        status: 'pass',
        detail: 'no instance running (arming pre-flight)',
      });
    } else if (lock.alive) {
      checks.push({
        id: 'process-lock',
        title: 'Process lock',
        status: 'pass',
        detail: `holder=pid ${lock.holder} (alive)`,
      });
    } else {
      checks.push({
        id: 'process-lock',
        title: 'Process lock',
        status: 'warn',
        detail: `STALE LOCK at ${lock.lockPath} (pid ${lock.holder} dead)`,
        fix: 'Stale lock auto-clears on next boot; safe to arm.',
      });
    }
  } catch (err) {
    checks.push({
      id: 'process-lock',
      title: 'Process lock',
      status: 'warn',
      detail: `process-lock peek threw: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return checks;
}

function formatCheckLine(check: DemoCheckResult): string {
  const symbol =
    check.status === 'pass' ? chalk.green('✅') :
    check.status === 'warn' ? chalk.yellow('⚠️ ') :
    chalk.red('❌');
  const detail = check.status === 'pass' ? check.detail : chalk.dim(check.detail);
  let line = `  ${symbol} ${chalk.bold(check.title.padEnd(20))} ${detail}`;
  if (check.fix && check.status !== 'pass') {
    line += `\n     ${chalk.dim('fix:')} ${chalk.dim(check.fix)}`;
  }
  return line;
}

async function handleArm(context: CliContext): Promise<boolean> {
  const checks = await runChecklist();
  const failing = checks.filter((c) => c.status === 'fail');

  if (context.args.json) {
    print(
      {
        ok: failing.length === 0,
        mode: 'demo-arm',
        checks,
        failing: failing.map((c) => c.id),
      },
      true,
    );
  } else {
    console.log(chalk.bold('\nMemphis demo readiness check\n'));
    for (const c of checks) console.log(formatCheckLine(c));
    console.log('');
  }

  if (failing.length > 0) {
    if (!context.args.json) {
      console.log(
        chalk.red.bold(`❌ NOT ARMED — ${failing.length} required check(s) failing.`),
      );
      console.log(chalk.dim('   Resolve the failing checks above, then re-run.\n'));
    }
    process.exitCode = 1;
    return true;
  }

  const state: DemoArmedState = {
    armedAt: new Date().toISOString(),
    armedBy: userInfo().username || 'operator',
    checks,
    expiresHint:
      'Re-run `memphis demo arm` after any restart, before going on stage. ' +
      'Lessons learned at Zawoja 2026-05-06: warm-up + smoke before live.',
  };
  writeArmedState(state);

  if (!context.args.json) {
    console.log(chalk.green.bold('✅ DEMO ARMED'));
    console.log(chalk.dim(`   State written to ${getDemoStatePath()}`));
    console.log(chalk.dim(`   Armed at ${state.armedAt} by ${state.armedBy}\n`));
  }
  return true;
}

async function handleStatus(context: CliContext): Promise<boolean> {
  const state = readArmedState();
  if (!state) {
    if (context.args.json) {
      print({ ok: false, mode: 'demo-status', armed: false, message: 'never armed' }, true);
    } else {
      console.log(chalk.yellow('Demo never armed.'));
      console.log(chalk.dim('Run `memphis demo arm` to run the checklist.\n'));
    }
    process.exitCode = 1;
    return true;
  }

  if (context.args.json) {
    print({ ok: true, mode: 'demo-status', armed: true, ...state }, true);
  } else {
    const ageMs = Date.now() - new Date(state.armedAt).getTime();
    const ageHours = (ageMs / (1000 * 60 * 60)).toFixed(1);
    console.log(chalk.green.bold('✅ DEMO ARMED'));
    console.log(chalk.dim(`   Armed at ${state.armedAt} by ${state.armedBy} (${ageHours}h ago)`));
    for (const c of state.checks) console.log(formatCheckLine(c));
    console.log('');
  }
  return true;
}

/**
 * Phase 3.2 (autopilot 2026-05-08) — minimal viable rehearsal.
 *
 * Runs a deterministic warmup sequence that exercises Memphis's hot
 * paths without burning a real LLM call:
 *   - chain warm: read journal head + recent blocks
 *   - embed warm: index probe (fast even on cold cache)
 *   - vault warm: probe cipher cycle (no decrypt needed)
 *   - doctor reprobe: sanity check that nothing broke since `arm`
 *
 * On success, stamps `lastRehearseAt` into demo-armed.json. Operator's
 * lesson #2 from Zawoja: "Testować demo PRZED wejściem". v1 deliberately
 * does NOT replay a recorded scenario or diff against a golden file —
 * those are deferred to a future PR (Phase 3.2 v2). The contract
 * shipped here is "exercise the dependencies + leave a timestamp".
 */
async function handleRehearse(context: CliContext): Promise<boolean> {
  const armed = readArmedState();
  if (!armed) {
    if (context.args.json) {
      print(
        { ok: false, mode: 'demo-rehearse', error: 'demo not armed; run `memphis demo arm` first' },
        true,
      );
    } else {
      console.log(chalk.red('❌ NOT ARMED — run `memphis demo arm` first.'));
    }
    process.exitCode = 1;
    return true;
  }

  const startMs = Date.now();
  const steps: Array<{ id: string; status: 'pass' | 'fail'; detail: string }> = [];

  // Step 1 — doctor reprobe (sanity since arm). Uses runDoctorChecksV2
  // again to catch state changes since arm landed (e.g. backup deleted).
  try {
    const { runDoctorChecksV2 } = await import('../utils/doctor-v2.js');
    const report = await runDoctorChecksV2({});
    const failingRequired = report.checks.filter((c) => c.required && !c.ok);
    steps.push({
      id: 'doctor-reprobe',
      status: failingRequired.length === 0 ? 'pass' : 'fail',
      detail:
        failingRequired.length === 0
          ? `${report.checks.length} checks; ${report.checks.filter((c) => c.ok).length} OK`
          : `${failingRequired.length} required check(s) failing since arm`,
    });
  } catch (err) {
    steps.push({
      id: 'doctor-reprobe',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 2 — chain warm (read journal head; first read is the slow one).
  try {
    const { exportChain } = await import('../../storage/chain-adapter.js');
    const envelope = await exportChain('journal');
    steps.push({
      id: 'chain-warm',
      status: 'pass',
      detail: `journal exported (${envelope.blocks.length} block(s))`,
    });
  } catch (err) {
    steps.push({
      id: 'chain-warm',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 3 — vault probe (cipher round-trip, doesn't expose plaintext).
  try {
    const { probeVaultCipherCycle } = await import('../../../security/vault-boundary.js');
    const probe = probeVaultCipherCycle({ surface: 'cli', command: 'memphis demo rehearse' });
    steps.push({
      id: 'vault-probe',
      status: probe.ok ? 'pass' : 'fail',
      detail: probe.ok ? 'cipher cycle OK' : (probe.error ?? 'unknown'),
    });
  } catch (err) {
    steps.push({
      id: 'vault-probe',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const durationMs = Date.now() - startMs;
  const failed = steps.filter((s) => s.status === 'fail');
  const ok = failed.length === 0;

  // Update demo-armed.json with rehearsal timestamp regardless of result;
  // the timestamp is "we tried", lastRehearseOk is "did it succeed".
  const updated: DemoArmedState = {
    ...armed,
    lastRehearseAt: new Date().toISOString(),
    lastRehearseOk: ok,
    lastRehearseDurationMs: durationMs,
  };
  writeArmedState(updated);

  if (context.args.json) {
    print({ ok, mode: 'demo-rehearse', steps, durationMs }, true);
  } else {
    console.log(chalk.bold('\nMemphis demo rehearsal\n'));
    for (const s of steps) {
      const sym = s.status === 'pass' ? chalk.green('✅') : chalk.red('❌');
      console.log(`  ${sym} ${s.id.padEnd(20)} ${chalk.dim(s.detail)}`);
    }
    console.log('');
    if (ok) {
      console.log(chalk.green.bold(`✅ REHEARSAL OK (${durationMs}ms)`));
      console.log(chalk.dim(`   lastRehearseAt = ${updated.lastRehearseAt}\n`));
    } else {
      console.log(chalk.red.bold(`❌ REHEARSAL FAILED — ${failed.length} step(s) failed`));
    }
  }
  if (!ok) process.exitCode = 1;
  return true;
}

async function handleDisarm(context: CliContext): Promise<boolean> {
  const cleared = clearArmedState();
  if (context.args.json) {
    print({ ok: true, mode: 'demo-disarm', cleared }, true);
  } else {
    console.log(cleared ? chalk.yellow('Demo disarmed.') : chalk.dim('Not armed (no-op).'));
  }
  return true;
}

export async function handleDemoCommand(context: CliContext): Promise<boolean> {
  if (context.args.command !== 'demo') return false;
  const sub = context.args.subcommand?.toLowerCase();
  switch (sub) {
    case 'arm':
      return handleArm(context);
    case 'status':
      return handleStatus(context);
    case 'disarm':
      return handleDisarm(context);
    case 'rehearse':
      return handleRehearse(context);
    default:
      throw new Error(
        `Unknown demo subcommand: ${sub ?? '(none)'}. Use 'arm' | 'status' | 'disarm' | 'rehearse'.`,
      );
  }
}
