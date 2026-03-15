import { spawnSync } from 'node:child_process';

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
  });
  const durationMs = Date.now() - gateStart;
  const exitCode = gateResult.status ?? 1;
  const ok = exitCode === 0;

  let gateError: string | null = null;
  if (!ok) {
    gateError = gateResult.stderr?.trim() || gateResult.stdout?.trim() || `exit code ${exitCode}`;
    firstFailure = firstFailure ?? `${gate.id} failed (${gateError})`;
  }

  gateResults.push({
    id: gate.id,
    command: [gate.command, ...gate.args].join(' '),
    ok,
    exitCode,
    durationMs,
    error: gateError,
  });

  if (!ok) {
    if (!jsonMode) {
      console.error(`[FAIL] ${gate.id} failed with exit code ${exitCode}`);
      if (gateError) console.error(gateError);
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
