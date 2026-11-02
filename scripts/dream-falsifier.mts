/**
 * D1 falsifier — Dreaming corpus over the real operator chat log.
 *
 * WHY THIS SCRIPT EXISTS
 * -----------------------
 * `docs/design/DREAMING.md` defines stage D1 with a falsifier:
 * the corpus built over the real database must reproduce the message
 * count, the session count, the tool-call count and the 1:1 join
 * between calls and their results. A design that cannot be falsified
 * in one run is a design that is six PRs from knowing it was wrong.
 *
 * The counts in the design document were measured on 2026-11-02 and
 * the database keeps growing, so this script prints the live numbers
 * AND the derived invariants that must hold regardless of growth:
 *
 *   - every call id joins exactly one tool row (no orphans, no dupes)
 *   - every tool result parses (unknownOutcomes = 0, unparsed = 0)
 *   - the wrapper split holds: user + tool rows are wrapped,
 *     assistant rows are not
 *
 * It also previews what stage D2 (deterministic signals) will see:
 * the tool names that do not exist at all.
 *
 * USAGE
 * -----
 *   npm run -s ops:dream-falsifier          # uses DATABASE_URL or ./data/memphis.db
 *   DATABASE_URL=file:/path/to/memphis.db npm run -s ops:dream-falsifier
 */

import { loadDreamingCorpus } from '../src/cognitive/dreaming/load.js';

const databaseUrl = process.env.DATABASE_URL?.trim() || 'file:./data/memphis.db';

const started = Date.now();
const corpus = loadDreamingCorpus({ rawEnv: { ...process.env, DATABASE_URL: databaseUrl } });
const elapsed = Date.now() - started;

console.log(`database: ${databaseUrl}`);
console.log(`status: ${corpus.status} (${elapsed} ms)`);
if (corpus.status !== 'ok') {
  console.log('no chat log to dream about');
  process.exit(0);
}

console.log('\n--- corpus ---');
console.log(JSON.stringify(corpus.stats, null, 2));

// The 1:1 join: a call's name and arguments live on the assistant row,
// its outcome lives on the tool row, and tool_call_id links them.
const callIds = new Map<string, number>();
for (const turn of corpus.turns) {
  for (const call of turn.calls ?? []) {
    callIds.set(call.id, (callIds.get(call.id) ?? 0) + 1);
  }
}
const toolIds = new Map<string, number>();
for (const turn of corpus.turns) {
  if (turn.role === 'tool' && turn.toolCallId) {
    toolIds.set(turn.toolCallId, (toolIds.get(turn.toolCallId) ?? 0) + 1);
  }
}

const duplicatedCalls = [...callIds.values()].filter((n) => n > 1).length;
const duplicatedTools = [...toolIds.values()].filter((n) => n > 1).length;
const callsWithoutResult = [...callIds.keys()].filter((id) => !toolIds.has(id)).length;
const resultsWithoutCall = [...toolIds.keys()].filter((id) => !callIds.has(id)).length;

console.log('\n--- join invariant ---');
console.log(`call ids: ${callIds.size} | tool ids: ${toolIds.size}`);
console.log(`duplicated call ids: ${duplicatedCalls}`);
console.log(`duplicated tool ids: ${duplicatedTools}`);
console.log(`calls without a result: ${callsWithoutResult}`);
console.log(`results without a call: ${resultsWithoutCall}`);

const stats = corpus.stats;
const wrapperHolds = stats.wrapped === stats.userTurns + stats.toolTurns;
console.log('\n--- invariants ---');
console.log(`every envelope parsed: ${stats.unparsed === 0 && stats.unknownOutcomes === 0}`);
console.log(`wrapper split holds (user+tool wrapped, assistant bare): ${wrapperHolds}`);
console.log(
  `join is 1:1: ${duplicatedCalls === 0 && duplicatedTools === 0 && callsWithoutResult === 0 && resultsWithoutCall === 0}`,
);

// Stage D2 preview: tool names the runtime does not know.
const byTool = new Map<string, { calls: number; failures: number }>();
for (const turn of corpus.turns) {
  for (const call of turn.calls ?? []) {
    const entry = byTool.get(call.name) ?? { calls: 0, failures: 0 };
    entry.calls += 1;
    if (call.outcome?.ok === false) entry.failures += 1;
    byTool.set(call.name, entry);
  }
}

console.log('\n--- tools with failures ---');
for (const [name, value] of [...byTool.entries()]
  .filter(([, v]) => v.failures > 0)
  .sort((a, b) => b[1].failures - a[1].failures)) {
  console.log(`${name}: ${value.failures}/${value.calls}`);
}

const unknownNames = [...byTool.keys()].filter((name) => name.includes('mephis_'));
console.log('\n--- names containing "mephis_" (typo class) ---');
for (const name of unknownNames) console.log(`${name}: ${byTool.get(name)?.calls}`);

const typoSessions = new Map<string, number>();
for (const turn of corpus.turns) {
  for (const call of turn.calls ?? []) {
    if (call.name.includes('mephis_')) {
      typoSessions.set(turn.sessionId, (typoSessions.get(turn.sessionId) ?? 0) + 1);
    }
  }
}
console.log(
  `\ntypo calls by session: ${JSON.stringify(
    [...typoSessions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
  )}`,
);
console.log(`total typo calls: ${[...typoSessions.values()].reduce((a, b) => a + b, 0)}`);
