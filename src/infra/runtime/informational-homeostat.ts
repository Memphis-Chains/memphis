/**
 * The informational homeostat.
 *
 * Mazur, "Cybernetyczna teoria układów samodzielnych" (PWN 1966), rozdz.
 * 10: a self-regulating system runs two circuits. The reactive circuit
 * fights disturbances through the accumulator; the informational circuit,
 * through the correlator, prevents them. The organ that ties them together
 * — the homeostat — is what lets the system modify its own STRUCTURE.
 *
 * Until now the runtime had the second circuit's input (the SLO report)
 * and the first circuit's output (repair, restart, degrade), but nothing
 * joined them: a failing SLO produced a line in a message to the operator
 * and nothing else. This module is that joint — a decision, with a reason,
 * about what the runtime itself should do about a failing measurement.
 *
 * Four rules, each of them a measurement rather than an intention:
 *
 * 1. NO EVIDENCE, NO ACTION. A failing metric whose newest sample is
 *    older than the freshness bound is not a current fault. Acting on it
 *    would let a runtime repair itself because of a failure that stopped
 *    happening days ago.
 * 2. UNKNOWN METRICS ESCALATE. The homeostat only knows what it was
 *    taught. A failing metric it cannot classify is the operator's, not
 *    its own.
 * 3. THE MOST CONSERVATIVE ACTION WINS. Escalation beats repair, repair
 *    beats shedding load, shedding load beats a restart. A restart under
 *    an active operator session is an outage the system caused itself.
 * 4. THE OPERATOR'S CONSENT IS NOT THE RUNTIME'S TO SPEND. A restart
 *    needs tier-3 elevation (`requestRestart` refuses without it), so the
 *    homeostat can ASK for one; it cannot grant one.
 *
 * The decision layer is pure: no clock, no filesystem, no chain. The
 * executor takes the decision and runs it through handlers the caller
 * injects, so the wiring can be tested without a runtime and the runtime
 * can be tested without a network.
 */

/**
 * What the homeostat can DECIDE to do.
 *
 * Only two of these are executable by the runtime itself. `repair` and
 * `restart` are decisions the operator has to carry out, and they travel
 * with the decision as a REQUEST, not as an action:
 *
 * - a repair rewrites runtime state that the live writer owns. Repairing
 *   under a running writer is a race, measured on this host: the repair
 *   has to run with the service stopped.
 * - a restart needs a tier-3 elevation. `requestRestart` refuses without
 *   one, and a configuration value is not an elevation.
 *
 * So the runtime may shed optional background work (`degrade-mode`) and
 * it may tell the operator what it needs (`escalate`). Everything else is
 * a named request.
 */
export type HomeostatAction = 'none' | 'degrade-mode' | 'escalate';

export const HOMEIOSTAT_ACTIONS: readonly HomeostatAction[] = ['none', 'degrade-mode', 'escalate'];

/** What the operator is being asked to do about the failing metric. */
export type HomeostatRequest = 'repair' | 'restart' | 'inspect' | 'shed-load';

/**
 * The gated SLO metrics and the class of action each one calls for.
 *
 * - `tool_error_rate`: tools fail, so the runtime's own state is suspect.
 *   The repair path normalises the runtime without touching chain
 *   history (history rewriting needs the operator's consent), so it is
 *   the one action the runtime may take on its own.
 * - `provider_error_rate`: the provider layer is unreachable. A restart
 *   helps, but a restart is the operator's call.
 * - `p99_turn_latency_ms`: the runtime is slow, so it should shed the
 *   optional background work it can live without.
 * - `confabulation_rate`: the runtime said something untrue. Nothing the
 *   runtime does repairs that; the operator reads it.
 */
export const HOMEIOSTAT_SLO_ACTION: Readonly<
  Record<string, { action: HomeostatAction; request: HomeostatRequest }>
> = {
  // The runtime's own tools are failing: shed the optional background
  // work so the tools have room, and keep the watch running.
  tool_error_rate: { action: 'degrade-mode', request: 'shed-load' },
  // The provider layer is unreachable. Only a restart helps, and only the
  // operator can authorise one.
  provider_error_rate: { action: 'escalate', request: 'restart' },
  // A slow turn is not a broken turn. It is worth reading, not worth
  // changing the runtime for.
  p99_turn_latency_ms: { action: 'escalate', request: 'inspect' },
  // The runtime said something untrue. Nothing it does repairs that.
  confabulation_rate: { action: 'escalate', request: 'inspect' },
};

/** Most conservative first. The first match wins. */
export const HOMEIOSTAT_ACTION_PRECEDENCE: readonly HomeostatAction[] = [
  'escalate',
  'degrade-mode',
];

export interface HomeostatEvidence {
  /** Gated metrics whose verdict is `fail`. */
  failingSlos: readonly string[];
  /** Gated metrics with no verdict at all. They are never acted upon. */
  unavailableSlos: readonly string[];
  /**
   * Age of the OLDEST evidence behind the failing metrics, in ms.
   * `null` means there is no evidence at all.
   */
  evidenceAgeMs: number | null;
  /**
   * How the most recent activity of each failing metric's class ended.
   *
   * A window average can stay above its threshold for days after the
   * fault stopped. The runtime acts only on a failure that is happening
   * right now, so a metric whose last activity ended `ok` is not acted
   * upon.
   */
  activityStatusBySlo: Readonly<Record<string, 'ok' | 'error' | 'unknown'>>;
}

export interface HomeostatPolicy {
  /** Actions this runtime may execute on its own. */
  allowed: readonly HomeostatAction[];
  /** Evidence older than this is not evidence. */
  maxEvidenceAgeMs: number;
  /** Minimum time between two actions of the same kind for the same metric. */
  cooldownMs: number;
}

export interface HomeostatDecision {
  action: HomeostatAction;
  /** The metric the decision is about. */
  slo?: string;
  /** Why the decision is what it is. */
  reason: string;
  /** What the operator has to do, when the action is not the runtime's to take. */
  request?: HomeostatRequest;
}

export interface HomeostatActionResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

export interface HomeostatHandlers {
  /** Shed the optional background work. */
  degradeMode?: () => Promise<HomeostatActionResult> | HomeostatActionResult;
  /** Tell the operator what the runtime needs. */
  escalate?: (
    decision: HomeostatDecision,
  ) => Promise<HomeostatActionResult> | HomeostatActionResult;
}

export interface HomeostatOutcome {
  decision: HomeostatDecision;
  action: HomeostatAction;
  /** True when a handler ran and reported success. */
  executed: boolean;
  detail?: string;
  error?: string;
}

function planFor(slo: string): { action: HomeostatAction; request: HomeostatRequest } {
  return HOMEIOSTAT_SLO_ACTION[slo] ?? { action: 'escalate', request: 'inspect' };
}

function rank(action: HomeostatAction): number {
  const index = HOMEIOSTAT_ACTION_PRECEDENCE.indexOf(action);
  return index === -1 ? HOMEIOSTAT_ACTION_PRECEDENCE.length : index;
}

/**
 * Decide what the runtime should do about the failing SLOs.
 *
 * Pure: the caller supplies the evidence, the policy, the clock and the
 * previous action. Nothing here reads the environment, the disk or the
 * chain, so the decision can be replayed from a record.
 */
export function decideInformationalHomeostat(input: {
  evidence: HomeostatEvidence;
  policy: HomeostatPolicy;
  lastAction?: { action: HomeostatAction; slo?: string; atMs: number };
  nowMs: number;
}): HomeostatDecision {
  const failing = [...new Set(input.evidence.failingSlos)].sort();
  if (failing.length === 0) {
    return { action: 'none', reason: 'no gated SLO is failing' };
  }

  const age = input.evidence.evidenceAgeMs;
  if (age === null || !Number.isFinite(age)) {
    return {
      action: 'none',
      reason:
        'no telemetry evidence behind the failing SLO: there is nothing to act on, and a failure without evidence is not a fault',
    };
  }
  if (age > input.policy.maxEvidenceAgeMs) {
    return {
      action: 'none',
      reason: `the evidence behind the failing SLO is ${Math.round(age / 1000)}s old (bound ${Math.round(
        input.policy.maxEvidenceAgeMs / 1000,
      )}s): a stale failure is not a current fault`,
    };
  }

  const ranked = failing
    .map((slo) => ({ slo, ...planFor(slo) }))
    .sort((a, b) => rank(a.action) - rank(b.action) || a.slo.localeCompare(b.slo));
  const chosen = ranked[0]!;

  const activity = input.evidence.activityStatusBySlo[chosen.slo] ?? 'unknown';
  if (activity !== 'error') {
    return {
      action: 'none',
      slo: chosen.slo,
      reason: `the last ${chosen.slo} activity ended ${activity}: the window average is not a current fault`,
    };
  }

  const last = input.lastAction;
  if (
    last &&
    last.action === chosen.action &&
    last.slo === chosen.slo &&
    input.nowMs - last.atMs < input.policy.cooldownMs
  ) {
    return {
      action: 'none',
      slo: chosen.slo,
      reason: `cooldown: ${chosen.action} for ${chosen.slo} already ran ${Math.round(
        (input.nowMs - last.atMs) / 1000,
      )}s ago`,
    };
  }

  if (!input.policy.allowed.includes(chosen.action)) {
    if (input.policy.allowed.includes('escalate')) {
      return {
        action: 'escalate',
        slo: chosen.slo,
        reason: `${chosen.action} is not permitted in this runtime`,
        request: chosen.request,
      };
    }
    return {
      action: 'none',
      slo: chosen.slo,
      reason: `${chosen.action} is not permitted in this runtime`,
    };
  }

  if (chosen.action === 'escalate') {
    return {
      action: 'escalate',
      slo: chosen.slo,
      reason: `the failing SLO ${chosen.slo} is not the runtime's to fix on its own`,
      request: chosen.request,
    };
  }

  return {
    action: chosen.action,
    slo: chosen.slo,
    reason: `the failing SLO ${chosen.slo} calls for ${chosen.action}`,
    request: chosen.request,
  };
}

/**
 * Run the decision through the caller's handlers.
 *
 * A handler that throws is an outcome, not a crash: the homeostat runs
 * unattended, and an unattended loop that dies on the first error is a
 * loop that only ever works once.
 */
export async function runInformationalHomeostat(
  decision: HomeostatDecision,
  handlers: HomeostatHandlers,
): Promise<HomeostatOutcome> {
  if (decision.action === 'none') {
    return { decision, action: 'none', executed: false };
  }
  const handler = decision.action === 'degrade-mode' ? handlers.degradeMode : handlers.escalate;
  if (!handler) {
    return {
      decision,
      action: decision.action,
      executed: false,
      error: `no handler for ${decision.action}`,
    };
  }
  try {
    const result = await handler(decision);
    return {
      decision,
      action: decision.action,
      executed: result.ok,
      detail: result.detail,
      error: result.error,
    };
  } catch (error) {
    return {
      decision,
      action: decision.action,
      executed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseActionList(
  raw: string | undefined,
  fallback: readonly HomeostatAction[],
): HomeostatAction[] {
  const values = (raw ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0) return [...fallback];
  const valid = values.filter((value): value is HomeostatAction =>
    (HOMEIOSTAT_ACTIONS as readonly string[]).includes(value),
  );
  return valid.length > 0 ? valid : [...fallback];
}

function readPositiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * The policy this runtime runs under.
 *
 * `degrade-mode` is the only structural action the runtime takes on its
 * own, and it is reversible: it switches off the optional background
 * tasks and switches them back on when the runtime recovers. `escalate`
 * is always allowed — telling the operator what the runtime needs is not
 * a privilege.
 *
 * `repair` and `restart` are NOT in this list and cannot be added to it:
 * a repair rewrites state the live writer owns (it has to run with the
 * service stopped), and a restart needs a tier-3 elevation. A
 * configuration value is not an elevation.
 */
export function readHomeostatPolicy(rawEnv: NodeJS.ProcessEnv = process.env): HomeostatPolicy {
  return {
    allowed: parseActionList(rawEnv.MEMPHIS_HOMEOSTAT_ACTIONS, ['degrade-mode', 'escalate']),
    maxEvidenceAgeMs: readPositiveNumber(
      rawEnv.MEMPHIS_HOMEOSTAT_MAX_EVIDENCE_AGE_MS,
      60 * 60 * 1000,
    ),
    cooldownMs: readPositiveNumber(rawEnv.MEMPHIS_HOMEOSTAT_COOLDOWN_MS, 6 * 60 * 60 * 1000),
  };
}

/**
 * Which stream of activity a metric is measured from.
 *
 * The runtime acts only on a failure that is happening right now, and
 * "right now" is read from the most recent span of the metric's own
 * class — a tool error rate is about tools, a provider error rate is
 * about the provider.
 */
export const HOMEIOSTAT_SLO_ACTIVITY: Readonly<Record<string, 'turn' | 'provider' | 'tool'>> = {
  tool_error_rate: 'tool',
  provider_error_rate: 'provider',
  p99_turn_latency_ms: 'turn',
  confabulation_rate: 'turn',
};

export type HomeostatActivityEntry = { status?: 'ok' | 'error' | 'unknown' } | null;

/**
 * The status of the last activity behind each failing metric.
 *
 * A metric whose class never produced a span is `unknown`, and `unknown`
 * is not `error`: the runtime does not act on a failure it cannot see
 * happening.
 */
export function homeostatActivityStatus(
  failingSlos: readonly string[],
  recent: {
    turn?: HomeostatActivityEntry;
    provider?: HomeostatActivityEntry;
    tool?: HomeostatActivityEntry;
  },
): Record<string, 'ok' | 'error' | 'unknown'> {
  const statuses: Record<string, 'ok' | 'error' | 'unknown'> = {};
  for (const slo of failingSlos) {
    const className = HOMEIOSTAT_SLO_ACTIVITY[slo];
    if (!className) {
      statuses[slo] = 'unknown';
      continue;
    }
    const entry = recent[className];
    const status = entry?.status;
    statuses[slo] = status === 'ok' || status === 'error' ? status : 'unknown';
  }
  return statuses;
}

/**
 * The scheduler tasks the runtime may shed while it is degraded.
 *
 * The watch itself and the scheduled backup are NOT in this list: a
 * homeostat that switches off the eye that watches it, or the copy that
 * protects the operator's data, has removed its own safety.
 */
export const HOMEIOSTAT_DEGRADABLE_TASK_IDS: readonly string[] = [
  'builtin-doctor-diagnose',
  'builtin-attachment-retention',
  'builtin-operator-briefing',
];

/** What the operator is being asked to do, in words. */
export function describeHomeostatRequest(request: HomeostatRequest | undefined): string {
  switch (request) {
    case 'repair':
      return 'stop the service, run `memphis repair runtime`, start it again';
    case 'restart':
      return 'restart the runtime with a tier-3 elevation';
    case 'shed-load':
      return 'the runtime shed the optional background work';
    case 'inspect':
      return 'inspect the failing metric and decide what it means';
    default:
      return 'nothing';
  }
}
