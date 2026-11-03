/**
 * The audit's own vocabulary.
 *
 * It is not a new one. `src/core/failure-classification.ts` already
 * settled the four states a measurement can land in, and the Dreaming
 * falsifier (`scripts/dream-signals.mts`) already uses them as a
 * contract: a detector that cannot reach the corpus must say
 * `unknown`, never `success`.
 *
 * The audit inherits that contract, because the whole point of S0 is
 * that a check which cannot see the live system must not be able to
 * report green. A gate that cannot measure is not a passing gate —
 * it is a gate that is lying, which is the exact failure this
 * repository has been repeating (docs/design/MEMPHIS-HOLES-AND-REFACTOR.md
 * §1, H3 and H4).
 */

import type { FailureClassification } from '../../core/failure-classification.js';

/**
 * `success`   — the check measured the thing and the thing is right.
 * `failure`   — the check measured the thing and the thing is wrong.
 * `inconclusive` — the check measured and the measurement cannot decide
 *                  (e.g. a block the core parses but that breaks the hash chain).
 * `unknown`   — the check could not reach what it measures (no live chains
 *                here, no network, no bridge). Never counted as success.
 */
export type AuditVerdict = FailureClassification;

export interface AuditCheckResult {
  /** Stable id, also the column name in the human output. */
  readonly id: string;
  /** One line: what this check is about. */
  readonly title: string;
  /** The four-state verdict. */
  readonly verdict: AuditVerdict;
  /** The numbers. One line, no prose. */
  readonly summary: string;
  /** The evidence behind the summary. */
  readonly details: readonly string[];
}

export interface RuntimeAuditReport {
  readonly checks: readonly AuditCheckResult[];
  /** The worst verdict in the report, in the order failure > inconclusive > unknown > success. */
  readonly overall: AuditVerdict;
  readonly failures: number;
  readonly inconclusive: number;
  readonly unknown: number;
  readonly ok: boolean;
  /** ISO timestamp of the run. */
  readonly generatedAt: string;
}

const VERDICT_SEVERITY: Record<AuditVerdict, number> = {
  failure: 3,
  inconclusive: 2,
  unknown: 1,
  success: 0,
};

export function worstVerdict(verdicts: readonly AuditVerdict[]): AuditVerdict {
  let worst: AuditVerdict = 'success';
  for (const verdict of verdicts) {
    if (VERDICT_SEVERITY[verdict] > VERDICT_SEVERITY[worst]) worst = verdict;
  }
  return worst;
}

export function isOpenVerdict(verdict: AuditVerdict): boolean {
  return verdict !== 'success';
}
