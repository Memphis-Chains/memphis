/**
 * D2 falsifier — run the deterministic detectors over the real corpus.
 *
 * The design (docs/design/DREAMING.md §3.3) gives D2 one falsifier:
 * the detectors must find the calls that went to tool names which do
 * not exist — a real agent bug that no chain-only reflection can see.
 * This script prints the signals and checks that verdict.
 *
 * USAGE
 * -----
 *   npm run -s ops:dream-signals
 *   DATABASE_URL=file:/path/to/memphis.db npm run -s ops:dream-signals
 */

import { loadDreamingCorpus } from '../src/cognitive/dreaming/load.js';
import { detectSignals } from '../src/cognitive/dreaming/signals.js';

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
process.exit(found ? 0 : 1);
