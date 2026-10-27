/**
 * memphis_classify — advisory typed decisions via a local BASAL service.
 *
 * BASAL reads a *state* (a message, a document, a case file) and answers a
 * typed question about it — `choice`, yes/no (`noul`) or `score` — by
 * returning a probability per allowed option, without generating free text. Categories are described in the request,
 * so one model serves many taxonomies without retraining.
 *
 * Validate the complete probability distribution before applying a caller
 * policy threshold. `auto` is advisory eligibility, never permission to run
 * a tool or a claim about the error rate on the operator's own data. Model,
 * backend and domain changes require separate calibration and evaluation.
 *
 * SERVICE
 * `~/.local/share/basal/basal_cpu.py` (port 8000, POST /v1/systemone).
 * Not started automatically — see `hint` on the not-running branch. The
 * service is a separate process because the model is a 1.5B-parameter
 * Python/torch stack, not a node dependency.
 *
 * LATENCY
 * Historical measurements of the installed 1.5B CPU service on this host
 * were about 70 s at orders=1 and 140 s at orders=2. These are not Pico
 * measurements. Reported `latency_ms` describes the individual service call.
 *
 * Not a hot-path tool: it is tier 2 and read-only against an external
 * service, but a call blocks for minutes on this host.
 */
const DEFAULT_URL = 'http://127.0.0.1:8000/v1/systemone';
const DEFAULT_THRESHOLD = 0.93;
/** Cap so a wedged service cannot hold a tool call open forever. */
const REQUEST_TIMEOUT_MS = 300_000;

export type ClassifyQuestionType = 'choice' | 'noul' | 'score';

export interface MemphisClassifyInput {
  /** The text to classify: a message, a document, a case file. */
  state: string;
  /** What to decide about it, in plain language. */
  question: string;
  /**
   * Options, keyed. `{ "cards": "Reklamacje kart" }` gives you a key to
   * read in the result plus the description the model reasons over. A bare
   * array is also accepted and the options double as keys.
   */
  criteria: Record<string, string> | string[];
  /** choice = pick one option, noul = yes/no, score = ordinal 0..n-1. */
  type?: ClassifyQuestionType;
  /** Advisory confidence threshold; does not grant action permissions. */
  threshold?: number;
  /** 1 = one forward pass (fast, order-sensitive). 2 = averaged over both
   *  option orders (invariant, double the cost). */
  orders?: 1 | 2;
  /** Override the service URL; defaults to MEMPHIS_BASAL_URL. */
  serviceUrl?: string;
}

type CriteriaEntry = { key: string; description: string };

type ServiceAnswer = {
  type: string;
  choice?: string;
  noul?: string | number;
  score?: number;
  probabilities: Record<string, number>;
  confidence: number;
  deferred?: boolean;
  calibration?: 'validated' | 'unvalidated';
};

type ServiceResponse = {
  model?: string;
  answers?: Record<string, ServiceAnswer>;
  usage?: { latency_ms?: number; questions?: number };
  error?: string;
};

export type MemphisClassifyOutput =
  | {
      ok: true;
      state: string;
      question: string;
      type: ClassifyQuestionType;
      choice: string | null;
      /** For `type: 'noul'` the service may answer with the option key
       * (string) or the winning index (number), depending on how criteria
       * were passed. Both are reported verbatim. */
      noul: string | number | null;
      score: number | null;
      probabilities: Record<string, number>;
      confidence: number;
      threshold: number;
      /** Valid response cleared caller policy and was not deferred. Advisory only. */
      auto: boolean;
      model: string | null;
      deferred: boolean;
      calibration: 'validated' | 'unvalidated' | 'unreported';
      orders: number;
      latencyMs: number;
    }
  | {
      ok: false;
      error: string;
      hint?: string;
      stateKind: 'no-service' | 'unreachable' | 'bad-request' | 'service-error' | 'timeout';
    };

function resolveUrl(rawEnv: NodeJS.ProcessEnv): string {
  const explicit = rawEnv.MEMPHIS_BASAL_URL?.trim();
  return explicit && explicit.length > 0 ? explicit : DEFAULT_URL;
}

function normalizeCriteria(criteria: MemphisClassifyInput['criteria']): CriteriaEntry[] {
  if (Array.isArray(criteria)) {
    return criteria
      .map((c) => ({ key: String(c), description: String(c) }))
      .filter((c) => c.key.trim().length > 0);
  }
  if (criteria && typeof criteria === 'object') {
    return Object.entries(criteria)
      .map(([key, description]) => ({ key, description: String(description) }))
      .filter((c) => c.key.trim().length > 0);
  }
  return [];
}

const PROBABILITY_TOLERANCE = 1e-4;
const MAX_SERVICE_RESPONSE_BYTES = 64 * 1024;

async function readServicePayload(response: Response): Promise<ServiceResponse> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SERVICE_RESPONSE_BYTES) {
      await reader.cancel();
      return {};
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as ServiceResponse;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validAnswer(
  value: unknown,
  type: ClassifyQuestionType,
  keys: string[],
): value is ServiceAnswer {
  if (!isRecord(value) || value.type !== type || !isRecord(value.probabilities)) return false;
  const probabilities = value.probabilities;
  const actualKeys = Object.keys(probabilities);
  const sameKeys = (expected: string[]) =>
    actualKeys.length === expected.length &&
    expected.every((key) => Object.hasOwn(probabilities, key));
  // Newer servers use canonical Boolean/ordinal keys; legacy servers retain criteria keys.
  if (
    !sameKeys(keys) &&
    !(type === 'noul' && sameKeys(['true', 'false'])) &&
    !(type === 'score' && sameKeys(keys.map((_, i) => String(i))))
  )
    return false;
  const values = Object.values(probabilities);
  if (!values.every((p) => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1))
    return false;
  const numbers = values as number[];
  if (Math.abs(numbers.reduce((sum, p) => sum + p, 0) - 1) > PROBABILITY_TOLERANCE) return false;
  const confidence = value.confidence;
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    Math.abs(confidence - Math.max(...numbers)) > PROBABILITY_TOLERANCE
  )
    return false;
  if (value.deferred !== undefined && typeof value.deferred !== 'boolean') return false;
  if (
    value.calibration !== undefined &&
    value.calibration !== 'validated' &&
    value.calibration !== 'unvalidated'
  )
    return false;
  if (type === 'choice')
    return (
      typeof value.choice === 'string' &&
      keys.includes(value.choice) &&
      Math.abs(Number(probabilities[value.choice]) - confidence) <= PROBABILITY_TOLERANCE
    );
  if (type === 'noul') {
    if (typeof value.noul === 'string')
      return (
        actualKeys.includes(value.noul) &&
        Math.abs(Number(probabilities[value.noul]) - confidence) <= PROBABILITY_TOLERANCE
      );
    if (
      typeof value.noul !== 'number' ||
      !Number.isFinite(value.noul) ||
      value.noul < 0 ||
      value.noul > 1
    )
      return false;
    if (sameKeys(['true', 'false']))
      return Math.abs(value.noul - Number(probabilities.true)) <= PROBABILITY_TOLERANCE;
    return (
      Number.isInteger(value.noul) &&
      Math.abs(Number(probabilities[keys[value.noul]]) - confidence) <= PROBABILITY_TOLERANCE
    );
  }
  const scoreKeys = sameKeys(keys) ? keys : keys.map((_, i) => String(i));
  const expectedScore = scoreKeys.reduce((sum, key, i) => sum + i * Number(probabilities[key]), 0);
  return (
    typeof value.score === 'number' &&
    Number.isFinite(value.score) &&
    Math.abs(value.score - expectedScore) <= PROBABILITY_TOLERANCE
  );
}

export async function runMemphisClassify(
  input: MemphisClassifyInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<MemphisClassifyOutput> {
  const state = input.state?.toString().trim();
  if (!state) {
    return {
      ok: false,
      error: 'memphis_classify requires a non-empty state',
      stateKind: 'bad-request',
    };
  }
  const question = input.question?.toString().trim();
  if (!question) {
    return {
      ok: false,
      error: 'memphis_classify requires a non-empty question',
      stateKind: 'bad-request',
    };
  }

  const options = normalizeCriteria(input.criteria);
  if (options.length < 2) {
    return {
      ok: false,
      error: 'memphis_classify requires at least two criteria options',
      stateKind: 'bad-request',
      hint: 'A single option carries no decision. Pass {key: description} pairs.',
    };
  }
  if (options.length > 10) {
    return {
      ok: false,
      error: `memphis_classify supports at most 10 options, got ${options.length}`,
      stateKind: 'bad-request',
    };
  }

  if (
    new Set(options.map((option) => option.key)).size !== options.length ||
    (input.type !== undefined && !['choice', 'noul', 'score'].includes(input.type)) ||
    (input.orders !== undefined && input.orders !== 1 && input.orders !== 2) ||
    (input.threshold !== undefined &&
      (!Number.isFinite(input.threshold) || input.threshold < 0 || input.threshold > 1))
  ) {
    return {
      ok: false,
      stateKind: 'bad-request',
      error: 'Invalid classification options, type, orders or threshold',
    };
  }

  const type = input.type ?? 'choice';
  const threshold =
    typeof input.threshold === 'number' && Number.isFinite(input.threshold)
      ? input.threshold
      : DEFAULT_THRESHOLD;
  const orders = input.orders === 1 ? 1 : 2;
  const url = resolveUrl(rawEnv);

  const body = {
    state,
    orders,
    questions: {
      k: {
        type,
        instructions: question,
        criteria: Object.fromEntries(options.map((o) => [o.key, o.description])),
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  let payload: ServiceResponse = {};
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.ok) payload = await readServicePayload(response);
    else await response.body?.cancel();
  } catch (err) {
    const aborted =
      controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
    return {
      ok: false,
      error: aborted
        ? `BASAL did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`
        : `Cannot reach the BASAL service at ${url}`,
      stateKind: aborted ? 'timeout' : 'unreachable',
      hint: `Start it with: cd ~/.local/share/basal && setsid ./venv/bin/python ./basal_cpu.py & — then GET ${url.replace('/v1/systemone', '/health')} to confirm readiness.`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `BASAL service returned HTTP ${response.status}`,
      stateKind: 'service-error',
    };
  }

  if (!isRecord(payload) || payload.error) {
    return {
      ok: false,
      error: 'BASAL service reported an inference error',
      stateKind: 'service-error',
      hint:
        isRecord(payload) && payload.error === 'loading'
          ? 'The model is still loading; retry in a few seconds.'
          : undefined,
    };
  }

  const answer = isRecord(payload.answers) ? payload.answers.k : undefined;
  if (
    !validAnswer(
      answer,
      type,
      options.map((option) => option.key),
    )
  ) {
    return {
      ok: false,
      error: 'BASAL returned an invalid typed decision or probability distribution',
      stateKind: 'service-error',
    };
  }

  const confidence = answer.confidence;
  const deferred = answer.deferred === true;
  const calibration = answer.calibration ?? 'unreported';

  return {
    ok: true,
    state,
    question,
    type,
    choice: answer.choice ?? null,
    noul: answer.noul === undefined ? null : (answer.noul as string | number),
    score: typeof answer.score === 'number' ? answer.score : null,
    probabilities: answer.probabilities,
    confidence,
    threshold,
    auto: confidence >= threshold && !deferred && calibration !== 'unvalidated',
    model: typeof payload.model === 'string' ? payload.model : null,
    deferred,
    calibration,
    orders,
    latencyMs:
      typeof payload.usage?.latency_ms === 'number' &&
      Number.isFinite(payload.usage.latency_ms) &&
      payload.usage.latency_ms >= 0
        ? payload.usage.latency_ms
        : -1,
  };
}
