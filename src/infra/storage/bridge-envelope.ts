/**
 * The one place the Rust bridge's JSON contract is understood.
 *
 * ## Why this module exists
 *
 * The Rust core speaks JSON over N-API with a single envelope shape:
 *
 * ```json
 * { "ok": true,  "data": { ... }, "error": null }
 * { "ok": false, "data": null,     "error": "..." }
 * ```
 *
 * Six TypeScript modules used to parse that envelope independently. Two of
 * them did not even catch a `JSON.parse` failure, so a stale or foreign
 * binary produced a raw `SyntaxError` instead of a bridge error; and
 * none of them handled the case where the bridge *throws* rather than
 * returns.
 *
 * That last case is the important one. Every export of `memphis-napi` is
 * now declared `#[napi(catch_unwind)]`, which means a Rust panic inside
 * the core arrives in JavaScript as a thrown error instead of unwinding
 * across the FFI boundary — where it would abort the process with
 * SIGABRT, taking the whole runtime down with it, and where no
 * `try`/`catch` in JavaScript could have helped.
 *
 * Before this module existed, such a panic surfaced as an unhandled
 * exception at whatever call site happened to be nearest. Now it is a
 * normal bridge error with the function name attached, and the caller
 * handles it the way it handles every other bridge failure.
 *
 * ## The rule
 *
 * One parser, one error shape, one place. A new bridge call site uses
 * `callBridge` and does not re-implement the parsing.
 */

/** The envelope the Rust bridge returns. */
export interface BridgeEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse a bridge envelope that has already been returned.
 *
 * @param raw  the JSON string the bridge returned.
 * @param fnName  the bridge function name, used to make the error legible.
 */
export function parseEnvelope<T>(raw: string, fnName: string): T {
  let out: BridgeEnvelope<T>;
  try {
    out = JSON.parse(raw) as BridgeEnvelope<T>;
  } catch (error) {
    throw new Error(`${fnName}: invalid JSON response (${messageOf(error)})`, { cause: error });
  }

  if (!out.ok) {
    throw new Error(`${fnName}: ${out.error ?? 'bridge returned error'}`);
  }

  if (out.data === undefined) {
    throw new Error(`${fnName}: bridge returned empty data`);
  }

  return out.data;
}

/**
 * Call a bridge function and parse its envelope.
 *
 * `invoke` is the bridge call itself. A throw from it — which is how a
 * panic-guarded Rust panic surfaces — becomes a normal bridge error
 * carrying the function name, instead of an exception that escapes into
 * whatever the caller was doing.
 */
export function callBridge<T>(fnName: string, invoke: () => string): T {
  let raw: string;
  try {
    raw = invoke();
  } catch (error) {
    throw new Error(`${fnName}: ${messageOf(error)}`, { cause: error });
  }
  return parseEnvelope<T>(raw, fnName);
}
