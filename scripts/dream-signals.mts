/**
 * D2 falsifier — run the deterministic detectors over the real corpus.
 *
 * The design (docs/design/DREAMING.md §3.3) gives D2 one falsifier:
 * the detectors must find the calls that went to tool names which do
 * not exist — a real agent bug that no chain-only reflection can see.
 * This script prints the signals and checks that verdict.
 *
 * It checks a second verdict, added with the S2 fix: the repeat-loop
 * detector must report exactly the loops the corpus contains. The recount
 * is independent — it starts from the rows, groups by tool + normalized
 * arguments and never asks the detector anything — so a detector that
 * drops a loop or invents one fails here.
 *
 * USAGE
 * -----
 *   npm run -s ops:dream-signals
 *   DATABASE_URL=file:/path/to/memphis.db npm run -s ops:dream-signals
 */

import { loadDreamingCorpus } from '../src/cognitive/dreaming/load.js';
import { detectSignals, normalizeArgs } from '../src/cognitive/dreaming/signals.js';

const databaseUrl = process.env.DATABASE_URL?.trim() || 'file:./data/memphis.db';

const corpus = loadDreamingCorpus({
  rawEnv: { ...process.env, DATABASE_URL: databaseUrl },
});

console.log(`database: ${databaseUrl}`);
console.log(
  `status: ${corpus.status} | turns: ${corpus.stats.turns} | sessions: ${corpus.stats.sessions}`,
);
if (corpus.status !== 'ok') {
  console.log('no chat log to dream about');
  process.exit(0);
}

const signals = detectSignals(corpus.turns);

console.log(`\n=== ${signals.length} signal(s) ===`);
for (const signal of signals) {
  console.log(`\n[${signal.severity.toUpperCase()}] ${signal.kind} — ${signal.id}`);
  console.log(`  ${signal.summary}`);
  console.log(
    `  prevalence: ${signal.prevalence.occurrences} occurrence(s), ${signal.prevalence.sessions} session(s), ${signal.prevalence.spanDays} day(s), denominator ${signal.prevalence.denominator}`,
  );
  for (const item of signal.evidence) {
    console.log(`    - ${item.sessionId}#${item.sequence} ${item.quote}`);
  }
}

const byKind = new Map<string, number>();
for (const signal of signals) byKind.set(signal.kind, (byKind.get(signal.kind) ?? 0) + 1);
console.log('\n=== by kind ===');
for (const [kind, count] of byKind) console.log(`${kind}: ${count}`);

// ---- the falsifier ----
// Every call that went to a tool the runtime does not know failed with
// "unsupported native rust chat tool: X". The detector must find them
// all, and must find them from that error alone — not from a list of
// tool names somebody wrote down.
const UNKNOWN_TOOL_RE = /unsupported native rust chat tool:\s*(\S+)/;
let unknownCalls = 0;
const unknownBySession = new Map<string, number>();
for (const turn of corpus.turns) {
  for (const call of turn.calls ?? []) {
    if (call.outcome?.ok === false && UNKNOWN_TOOL_RE.test(call.outcome?.error ?? '')) {
      unknownCalls += 1;
      unknownBySession.set(turn.sessionId, (unknownBySession.get(turn.sessionId) ?? 0) + 1);
    }
  }
}
const detectedUnknown = signals
  .filter((signal) => signal.kind === 'tool-failure-cluster')
  .filter((signal) =>
    signal.evidence.some((item) => item.quote.includes('unsupported native rust chat tool')),
  )
  .reduce((sum, signal) => sum + signal.prevalence.occurrences, 0);
const topSession = [...unknownBySession.entries()].sort((a, b) => b[1] - a[1])[0];

console.log('\n=== D2 falsifier ===');
console.log(`calls to tools that do not exist: ${unknownCalls}`);
console.log(`detected by the signals:           ${detectedUnknown}`);
console.log(
  `most of them in one session:       ${topSession ? `${topSession[0]} (${topSession[1]})` : 'n/a'}`,
);
const found = detectedUnknown === unknownCalls && unknownCalls > 0;
console.log(found ? 'VERDICT: the detector finds every unknown-tool call' : 'VERDICT: MISMATCH');

// ---- the second falsifier: the loops themselves ----
// A loop is a group of identical calls that did not succeed at least twice.
// The detector groups by tool + normalized arguments; this recount groups the
// same way, but it starts from the corpus rows and never asks the detector
// anything. If the two disagree, the detector is dropping a loop or inventing
// one — which is exactly what happened when the detector counted only loud
// failures: three real loops of silent non-zero exits were invisible.
const expectedLoops = new Map<string, { notSucceeding: number; occurrences: number }>();
for (const turn of corpus.turns) {
  for (const call of turn.calls ?? []) {
    const key = `${call.name}|${normalizeArgs(call.args)}`;
    const entry = expectedLoops.get(key) ?? { notSucceeding: 0, occurrences: 0 };
    entry.occurrences += 1;
    const classification = call.outcome?.classification;
    if (classification === 'failure' || classification === 'inconclusive') {
      entry.notSucceeding += 1;
    }
    expectedLoops.set(key, entry);
  }
}
const expectedLoopKeys = new Set(
  [...expectedLoops.entries()].filter(([, entry]) => entry.notSucceeding >= 2).map(([key]) => key),
);
const reportedLoops = signals.filter((signal) => signal.kind === 'repeat-loop');
const reportedLoopKeys = new Set(
  reportedLoops.map((signal) => signal.id.slice('repeat-loop:'.length)),
);

const missed = [...expectedLoopKeys].filter((key) => !reportedLoopKeys.has(key));
const invented = [...reportedLoopKeys].filter((key) => !expectedLoopKeys.has(key));
const miscounted = reportedLoops.filter((signal) => {
  const key = signal.id.slice('repeat-loop:'.length);
  const expected = expectedLoops.get(key);
  return expected !== undefined && expected.notSucceeding !== signal.prevalence.occurrences;
});

console.log('\n=== S2 loop falsifier ===');
console.log(`loops the corpus contains:          ${expectedLoopKeys.size}`);
console.log(`loops the detector reports:         ${reportedLoopKeys.size}`);
console.log(`missed:                             ${missed.length}`);
console.log(`invented:                           ${invented.length}`);
console.log(`reported with the wrong count:      ${miscounted.length}`);
const loopsAgree = missed.length === 0 && invented.length === 0 && miscounted.length === 0;
console.log(
  loopsAgree ? 'VERDICT: the detector reports every loop the corpus contains' : 'VERDICT: MISMATCH',
);
for (const key of missed) console.log(`  missed:   ${key}`);
for (const key of invented) console.log(`  invented: ${key}`);
for (const signal of miscounted) console.log(`  miscounted: ${signal.id}`);

process.exit(found && loopsAgree ? 0 : 1);
