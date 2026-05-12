import { spawnSync } from 'node:child_process';

import { runMemphisExecAnalyze } from './exec-analyze.js';
import { MEMPHIS_EXEC_TIMEOUT_MS } from '../../config/env-registry.js';
import { AppError } from '../../core/errors.js';
import {
  describeBudgetRefusal,
  isExecBlockedForBudget,
  recordExecOutcome,
  type ExecFailureBudgetKey,
} from '../../gateway/exec-failure-budget.js';
import { enforceGatewayExecPolicy, loadGatewayExecPolicy } from '../../gateway/exec-policy.js';
import { writeSecurityAudit } from '../../infra/logging/security-audit.js';

// Phase 1.5.3: env-driven via MEMPHIS_EXEC_TIMEOUT_MS (default 1 h, was
// 120 s hardcode — long-running corpus builds + training need the headroom).
const EXEC_TIMEOUT_MS = MEMPHIS_EXEC_TIMEOUT_MS.read(process.env);
const MAX_OUTPUT_CHARS = 32_000;

export type MemphisExecInput = {
  command: string;
  /**
   * REV2 Temat 3.5 — operator-stated intent for audit context. The
   * LLM forwards the high-level user prompt that prompted this exec
   * so audit reviewers can trace WHY a command ran. Optional; absent
   * intent gets logged as "(none provided)".
   */
  surface_intent?: string;
};

export type MemphisExecOutput = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export interface RunMemphisExecDeps {
  /**
   * Surface + actor identity for the failure budget. When absent the
   * budget falls back to a global "unknown::unknown" bucket — fine for
   * unit tests; production callers thread the values through.
   */
  surface?: string;
  actorId?: string;
}

/**
 * Execute a safe command via the gateway exec policy.
 * Only allowlisted commands with validated arguments pass through.
 *
 * The rawEnv parameter is load-bearing for tier-3 elevation: when a tier-3
 * session is active the caller will have merged `MEMPHIS_AUTONOMY_MODE=full`
 * into rawEnv, which `loadGatewayExecPolicy` reads to drop restricted mode.
 * Passing process.env here bypasses that overlay.
 *
 * REV2 Temat 3.5 enhancements:
 *   - Pre-exec analysis via `runMemphisExecAnalyze` is attached to the
 *     `exec.attempt` audit so reviewers see predicted impact alongside
 *     the actual command.
 *   - Failure budget: after `MAX_CONSECUTIVE_FAILURES` (3) non-zero
 *     exits per (surface, actor), further calls refuse with a clear
 *     "stop blind-retrying" message. Counter resets on any non-exec
 *     tool call (tool-executor does that bookkeeping).
 *   - `exec.attempt` + `exec.result` audit events emit on every call,
 *     not just policy denials.
 */
export function runMemphisExec(
  input: MemphisExecInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
  deps: RunMemphisExecDeps = {},
): MemphisExecOutput {
  // Codex round-1 N1 (PR #601 review): WARN when production callers
  // forget to thread (surface, actorId). Without identity, the
  // failure budget falls back to a global "unknown::unknown" bucket
  // — one actor's blind-retry loop ends up masked under another
  // actor's budget. The check skips in vitest (deps absent is
  // intentional for unit tests).
  if (
    rawEnv.VITEST !== 'true' &&
    (deps.surface === undefined || deps.actorId === undefined)
  ) {
    process.stderr.write(
      `[memphis-exec] WARN: budget-key threading missing — ` +
        `surface=${deps.surface ?? '<undefined>'} actorId=${deps.actorId ?? '<undefined>'}. ` +
        `Failures will bucket under "unknown::unknown" and may mask retry loops.\n`,
    );
  }
  const policy = loadGatewayExecPolicy(rawEnv);
  const budgetKey: ExecFailureBudgetKey = {
    surface: deps.surface,
    actorId: deps.actorId,
  };

  // Failure-budget pre-check (Warstwa 5). Audit the refusal so an
  // operator reading the log sees WHY this exec was blocked even
  // before policy ran.
  if (isExecBlockedForBudget(budgetKey)) {
    const reason = describeBudgetRefusal(budgetKey);
    writeSecurityAudit(
      {
        action: 'exec.refused.budget',
        status: 'blocked',
        details: {
          command: input.command,
          surface: deps.surface,
          actorId: deps.actorId,
          reason,
        },
      },
      rawEnv,
    );
    throw new AppError('VALIDATION_ERROR', reason, 429);
  }

  // Pre-exec analysis (Warstwa 4). Run unconditionally — cheap pure
  // function. Surface as audit context so reviewers can compare
  // predicted vs actual outcome.
  const analysis = runMemphisExecAnalyze({
    command: input.command,
    surface_intent: input.surface_intent,
  });

  writeSecurityAudit(
    {
      action: 'exec.attempt',
      status: 'allowed',
      details: {
        command: input.command,
        semantic: analysis.semantic,
        side_effects: analysis.side_effects,
        reversibility: analysis.reversibility,
        warnings: analysis.warnings,
        tier_required: analysis.tier_required,
        recommendation: analysis.recommendation,
        surface_intent: input.surface_intent ?? '(none provided)',
        surface: deps.surface,
        actorId: deps.actorId,
        autonomy_mode: (rawEnv.MEMPHIS_AUTONOMY_MODE ?? '').toLowerCase() || '(unset)',
      },
    },
    rawEnv,
  );

  // Enforce allowlist + metachar + argument validation
  enforceGatewayExecPolicy(input.command, policy);

  const result = spawnSync('sh', ['-c', input.command], {
    encoding: 'utf8',
    timeout: EXEC_TIMEOUT_MS,
    stdio: 'pipe',
    env: { ...rawEnv },
  });

  if (result.error) {
    // Spawn-level failure (not a non-zero exit — process couldn't be
    // started at all). Treat as a failure for budget purposes so a
    // typo-loop doesn't ride the policy stage indefinitely.
    recordExecOutcome(budgetKey, 1);
    writeSecurityAudit(
      {
        action: 'exec.result',
        status: 'error',
        details: {
          command: input.command,
          exit_code: null,
          spawn_error: result.error.message,
          surface: deps.surface,
          actorId: deps.actorId,
        },
      },
      rawEnv,
    );
    throw new AppError('INTERNAL_ERROR', `exec failed: ${result.error.message}`, 500);
  }

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const truncated = stdout.length > MAX_OUTPUT_CHARS || stderr.length > MAX_OUTPUT_CHARS;
  const exitCode = result.status ?? 1;
  recordExecOutcome(budgetKey, exitCode);

  writeSecurityAudit(
    {
      action: 'exec.result',
      status: exitCode === 0 ? 'allowed' : 'error',
      details: {
        command: input.command,
        exit_code: exitCode,
        stdout_first_500: stdout.slice(0, 500),
        stderr_first_500: stderr.slice(0, 500),
        truncated,
        surface: deps.surface,
        actorId: deps.actorId,
      },
    },
    rawEnv,
  );

  return {
    command: input.command,
    exitCode,
    stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
    stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
    truncated,
  };
}
