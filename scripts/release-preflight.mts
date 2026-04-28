import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type PreflightGateId =
  | 'lint'
  | 'typecheck'
  | 'guardDrill'
  | 'strictHandoffFixtureValidator'
  | 'strictHandoffJsonGate'
  | 'opsArtifacts'
  | 'testTs'
  | 'testChaos'
  | 'testRust';

/**
 * Capture last N lines of a string. Used to surface enough vitest failure
 * context in the JSON summary's `error` field that operators can identify
 * the offending test without downloading the full archive logs.
 *
 * Why this matters: pre-fix, the `error` field only carried `stderr` —
 * but vitest writes test failure summaries (FAIL paths, AssertionError
 * messages, expected/received diffs) to STDOUT, not stderr. Failed runs
 * surfaced only stderr noise (e.g. pino info logs, security audit warnings)
 * and the actual test failure was invisible until the operator downloaded
 * GitHub Actions logs and grep'd through 130KB+ of escaped JSON. This
 * function + `stdoutTail`/`stderrTail` fields close that gap.
 */
function tailLines(text: string, lines: number): string {
  if (!text) return '';
  const all = text.split('\n');
  if (all.length <= lines) return text;
  return all.slice(-lines).join('\n');
}

function getRunnerTempDir(): string {
  const explicit = process.env.RUNNER_TEMP?.trim();
  if (explicit) return explicit;
  return tmpdir();
}

function persistGateOutput(
  gateId: string,
  stdout: string,
  stderr: string,
): { stdoutPath: string; stderrPath: string } | null {
  try {
    const dir = join(getRunnerTempDir(), 'release-preflight-gate-output');
    mkdirSync(dir, { recursive: true });
    const stdoutPath = join(dir, `${gateId}.stdout.log`);
    const stderrPath = join(dir, `${gateId}.stderr.log`);
    writeFileSync(stdoutPath, stdout, 'utf8');
    writeFileSync(stderrPath, stderr, 'utf8');
    return { stdoutPath, stderrPath };
  } catch {
    // Persistence is best-effort; never break the gate runner.
    return null;
  }
}

type PreflightGate = {
  id: PreflightGateId;
  command: string;
  args: string[];
};

type PreflightGateResult = {
  id: string;
  command: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  error: string | null;
  /** Last 50 lines of subprocess stdout — preserves vitest failure summaries. */
  stdoutTail: string | null;
  /** Last 50 lines of subprocess stderr — preserves runtime warnings + crashes. */
  stderrTail: string | null;
  /** Path to full stdout/stderr logs in RUNNER_TEMP for post-mortem download. */
  logPaths: { stdout: string; stderr: string } | null;
};

type PreflightSummary = {
  schemaVersion: 1;
  ok: boolean;
  startedAt: string;
  completedAt: string;
  gates: PreflightGateResult[];
  error: string | null;
};

const defaultGates: PreflightGate[] = [
  { id: 'lint', command: 'npm', args: ['run', '-s', 'lint'] },
  { id: 'typecheck', command: 'npm', args: ['run', '-s', 'typecheck'] },
  { id: 'guardDrill', command: './scripts/guard-drill-json-gate.sh', args: [] },
  {
    id: 'strictHandoffFixtureValidator',
    command: 'npm',
    args: ['run', '-s', 'ops:validate-strict-handoff-fixtures'],
  },
  {
    id: 'strictHandoffJsonGate',
    command: './scripts/strict-handoff-validator-json-gate.sh',
    args: [],
  },
  { id: 'opsArtifacts', command: 'npm', args: ['run', '-s', 'test:ops-artifacts'] },
  { id: 'testTs', command: 'npm', args: ['run', '-s', 'test:ts'] },
  { id: 'testChaos', command: 'npm', args: ['run', '-s', 'test:chaos'] },
  { id: 'testRust', command: 'npm', args: ['run', '-s', 'test:rust'] },
];

function usage(): string {
  return [
    'Usage: npm run -s ops:release-preflight -- [--json]',
    '',
    'Options:',
    '  --json   Emit machine-readable summary output',
    '',
    'Test override:',
    '  MEMPHIS_RELEASE_PREFLIGHT_GATE_OVERRIDE_JSON can provide an array of',
    '  { id, command, args } objects to override default gate commands',
    '  only when MEMPHIS_RELEASE_PREFLIGHT_ALLOW_TEST_OVERRIDE=1 is set.',
  ].join('\n');
}

function parseOverrideGates(): PreflightGate[] | null {
  const raw = process.env.MEMPHIS_RELEASE_PREFLIGHT_GATE_OVERRIDE_JSON;
  if (!raw) return null;
  if (process.env.MEMPHIS_RELEASE_PREFLIGHT_ALLOW_TEST_OVERRIDE !== '1') {
    throw new Error(
      'MEMPHIS_RELEASE_PREFLIGHT_GATE_OVERRIDE_JSON requires MEMPHIS_RELEASE_PREFLIGHT_ALLOW_TEST_OVERRIDE=1',
    );
  }

  const parsed = JSON.parse(raw) as Array<{ id?: string; command?: string; args?: unknown }>;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('MEMPHIS_RELEASE_PREFLIGHT_GATE_OVERRIDE_JSON must be a non-empty array');
  }

  return parsed.map((item, index) => {
    if (!item?.id || !item.command) {
      throw new Error(`override gate at index ${index} must include id and command`);
    }
    if (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== 'string')) {
      throw new Error(`override gate ${item.id} must include string[] args`);
    }
    return { id: item.id as PreflightGateId, command: item.command, args: item.args as string[] };
  });
}

function asErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(usage());
  process.exit(0);
}
for (const arg of args) {
  if (arg !== '--json') {
    console.error(`Unknown option: ${arg}`);
    console.error(usage());
    process.exit(2);
  }
}

const jsonMode = args.includes('--json');
let gates: PreflightGate[];
try {
  gates = parseOverrideGates() ?? defaultGates;
} catch (error) {
  const message = asErrorMessage(error);
  if (jsonMode) {
    const now = new Date().toISOString();
    const summary: PreflightSummary = {
      schemaVersion: 1,
      ok: false,
      startedAt: now,
      completedAt: now,
      gates: [],
      error: message,
    };
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.error(`[FAIL] release preflight input validation failed: ${message}`);
  }
  process.exit(2);
}

const startedAt = new Date().toISOString();
const gateResults: PreflightGateResult[] = [];
let firstFailure: string | null = null;

for (const gate of gates) {
  if (!jsonMode) {
    console.log(`[RUN] ${gate.id}: ${[gate.command, ...gate.args].join(' ')}`);
  }

  const gateStart = Date.now();
  const gateResult = spawnSync(gate.command, gate.args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    // Increase from default 1MB — vitest test:ts can produce ~5MB of
    // structured logs in heavy suites, and we don't want truncation
    // exactly when we're trying to debug failures.
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - gateStart;
  const exitCode = gateResult.status ?? 1;
  const ok = exitCode === 0;

  const stdoutFull = gateResult.stdout ?? '';
  const stderrFull = gateResult.stderr ?? '';
  const stdoutTail = tailLines(stdoutFull, 50);
  const stderrTail = tailLines(stderrFull, 50);

  // Persist full logs to RUNNER_TEMP so operators can `gh run download`
  // the artifact (or post-mortem read on local runs). Only persist on
  // failure to keep success-path lean — green gates don't need archives.
  const logPaths = !ok ? persistGateOutput(gate.id, stdoutFull, stderrFull) : null;

  let gateError: string | null = null;
  if (!ok) {
    // Build error message with both streams so vitest test failures
    // (which write to stdout) AND runtime warnings (stderr) are visible
    // in the single-line `error` field of the gate JSON summary.
    const stderrTrimmed = stderrFull.trim();
    const stdoutTrimmed = stdoutFull.trim();
    const composed = [
      stderrTrimmed && `--- stderr (last 50 lines) ---\n${stderrTail}`,
      stdoutTrimmed && `--- stdout (last 50 lines) ---\n${stdoutTail}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    gateError = composed || `exit code ${exitCode}`;
    firstFailure = firstFailure ?? `${gate.id} failed (exit ${exitCode}; see logPaths in summary)`;
  }

  gateResults.push({
    id: gate.id,
    command: [gate.command, ...gate.args].join(' '),
    ok,
    exitCode,
    durationMs,
    error: gateError,
    stdoutTail: ok ? null : stdoutTail || null,
    stderrTail: ok ? null : stderrTail || null,
    logPaths,
  });

  if (!ok) {
    if (!jsonMode) {
      // Emit failure summary directly to stderr so operators looking at
      // CI logs see the offending test names + assertion details
      // immediately, without needing to parse JSON or download archives.
      console.error(`[FAIL] ${gate.id} failed with exit code ${exitCode}`);
      if (logPaths) {
        console.error(`[FAIL]   stdout log: ${logPaths.stdout}`);
        console.error(`[FAIL]   stderr log: ${logPaths.stderr}`);
      }
      if (stderrTail) {
        console.error(`[FAIL] --- stderr (last 50 lines) ---`);
        console.error(stderrTail);
      }
      if (stdoutTail) {
        console.error(`[FAIL] --- stdout (last 50 lines) ---`);
        console.error(stdoutTail);
      }
    }
    break;
  }
}

const completedAt = new Date().toISOString();
const summary: PreflightSummary = {
  schemaVersion: 1,
  ok: firstFailure === null,
  startedAt,
  completedAt,
  gates: gateResults,
  error: firstFailure,
};

if (jsonMode) {
  console.log(JSON.stringify(summary, null, 2));
} else if (summary.ok) {
  console.log('[PASS] release preflight gates passed');
}

process.exit(summary.ok ? 0 : 1);
