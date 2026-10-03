/**
 * memphis_classify — typed decisions via the local BASAL-1.0 service.
 *
 * BASAL reads a *state* (a message, a document, a case file) and answers a
 * typed question about it — `choice`, yes/no (`noul`) or `score` — by
 * returning a calibrated probability per allowed option in a single forward
 * pass, without generating text. Categories are described in the request,
 * so one model serves many taxonomies without retraining.
 *
 * The confidence is the point. Unlike an LLM, which produces a string you
 * have to parse and trust, this returns a probability you can threshold:
 * `auto: true` means the decision cleared the bar, `auto: false` means a
 * human should look. Thresholds come from the model's own
 * CALIBRATION.json and are surfaced by `GET /health` on the service.
 *
 * SERVICE
 * `~/.local/share/basal/basal_cpu.py` (port 8000, POST /v1/systemone).
 * Not started automatically — see `hint` on the not-running branch. The
 * service is a separate process because the model is a 1.5B-parameter
 * Python/torch stack, not a node dependency.
 *
 * LATENCY
 * Measured on the operator's host (GTX 960, compute_cap 5.2, no
 * supported CUDA kernel): ~70 s at orders=1, ~140 s at orders=2. Same
 * model on an H100 is 12.5/25 ms. Two orders give a result that is
 * invariant to option ordering, at double the cost; one order is fine
 * for interactive probes where the caller can retry. `latency_ms` in the
 * response tells the caller which it was.
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
  /** Confidence at or above which the caller may act unattended. */
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
};

type ServiceResponse = {
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
      /** True when confidence >= threshold: safe to act on unattended. */
      auto: boolean;
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

  const type = input.type ?? 'choice';
  const threshold =
    typeof input.threshold === 'number' && Number.isFinite(input.threshold)
      ? Math.min(Math.max(input.threshold, 0), 1)
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
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
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
    const text = await response.text().catch(() => '');
    return {
      ok: false,
      error: `BASAL service returned HTTP ${response.status}`,
      stateKind: 'service-error',
      hint: text.slice(0, 400) || undefined,
    };
  }

  const payload = (await response.json().catch(() => ({}))) as ServiceResponse;
  if (payload.error) {
    return {
      ok: false,
      error: payload.error,
      stateKind: 'service-error',
      hint:
        payload.error === 'loading'
          ? 'The model is still loading; retry in a few seconds.'
          : undefined,
    };
  }

  const answer = payload.answers?.k;
  if (!answer || !answer.probabilities) {
    return {
      ok: false,
      error: 'BASAL response did not contain an answer for the question',
      stateKind: 'service-error',
    };
  }

  const confidence = answer.confidence;

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
    auto: confidence >= threshold,
    orders,
    latencyMs: payload.usage?.latency_ms ?? -1,
  };
}
