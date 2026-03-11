import { performance } from 'node:perf_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import {
  embedReset,
  embedSearch,
  embedSearchTuned,
  embedStore,
  getRustEmbedAdapterStatus,
} from './src/infra/storage/rust-embed-adapter.ts';

type Corpus = {
  docs: Array<{ id: string; text: string }>;
  cases: Array<{ query: string; relevant: string[] }>;
};

type Timing = { query: string; ms: number; status: '✅ PASS' | '❌ FAIL' };

const queries = ['v5 publishing', 'security first', 'codex agents'];
const topK = 5;

const EMBEDDED_CORPUS: Corpus = {
  docs: [
    {
      id: 'doc_publish_v5',
      text: 'Memphis v5 publishing checklist includes docs, changelog, smoke tests, and package verification.',
    },
    {
      id: 'doc_security_posture',
      text: 'Security-first defaults require chain integrity checks, signed artifacts, and strict provider policy.',
    },
    {
      id: 'doc_agent_handoff',
      text: 'Codex agent handoff should include context summary, constraints, and verification commands.',
    },
  ],
  cases: [
    { query: 'v5 publishing workflow', relevant: ['doc_publish_v5'] },
    { query: 'security first defaults', relevant: ['doc_security_posture'] },
    { query: 'codex agents handoff context', relevant: ['doc_agent_handoff'] },
  ],
};

function nowMs(): number {
  return performance.now();
}

function format(n: number): string {
  return `${n.toFixed(2)}ms`;
}

function summarize(times: Timing[]) {
  const values = times.map((t) => t.ms);
  const avg = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  const max = Math.max(...values);
  return { avg, max };
}

function measureQueries(label: string, fn: (q: string) => unknown): Timing[] {
  const out: Timing[] = [];
  for (const query of queries) {
    const start = nowMs();
    fn(query);
    const end = nowMs();
    const duration = end - start;
    out.push({
      query,
      ms: duration,
      status: duration < 200 ? '✅ PASS' : '❌ FAIL',
    });
  }

  console.log(`\n=== ${label} ===`);
  for (const row of out) {
    console.log(`Query: "${row.query}"`);
    console.log(`  Time: ${format(row.ms)}`);
    console.log(`  Status: ${row.status}`);
  }
  const s = summarize(out);
  console.log(`Average: ${format(s.avg)}`);
  console.log(`Max: ${format(s.max)}`);
  return out;
}

function loadCorpus(): { corpus: Corpus; source: 'file' | 'embedded-fallback' } {
  const p = resolve('data/retrieval-benchmark-corpus-v2.json');
  if (existsSync(p)) {
    try {
      return { corpus: JSON.parse(readFileSync(p, 'utf8')) as Corpus, source: 'file' };
    } catch {
      // Fall through to embedded fallback.
    }
  }
  return { corpus: EMBEDDED_CORPUS, source: 'embedded-fallback' };
}

function measureChainLoad(): { ms: number; bytes: number; records: number; source: 'file' | 'missing' } {
  const p = resolve('data/decision-history.jsonl');
  if (!existsSync(p)) {
    return { ms: 0, bytes: 0, records: 0, source: 'missing' };
  }
  const start = nowMs();
  const raw = readFileSync(p, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const end = nowMs();
  return { ms: end - start, bytes: Buffer.byteLength(raw), records: lines.length, source: 'file' };
}

function measureFsScan(query: string): number {
  const start = nowMs();
  execSync(
    `grep -RIn --binary-files=without-match --exclude-dir=node_modules "${query}" src packages >/dev/null || true`,
    {
      stdio: 'ignore',
      shell: '/bin/bash',
    },
  );
  const end = nowMs();
  return end - start;
}

function mb(n: number): number {
  return Number((n / (1024 * 1024)).toFixed(2));
}

async function main() {
  process.env.RUST_CHAIN_ENABLED = 'true';

  const status = getRustEmbedAdapterStatus(process.env);
  console.log('Rust embed adapter status:', status);

  const { corpus, source: corpusSource } = loadCorpus();
  console.log(
    'Corpus source:',
    corpusSource === 'file' ? 'data/retrieval-benchmark-corpus-v2.json' : 'embedded fallback corpus',
  );
  const chainLoad = measureChainLoad();
  console.log('\nChain load (decision-history.jsonl):', {
    ms: Number(chainLoad.ms.toFixed(2)),
    bytes: chainLoad.bytes,
    records: chainLoad.records,
    source: chainLoad.source,
  });

  const fsScanTimes: Timing[] = queries.map((query) => {
    const ms = measureFsScan(query);
    return { query, ms, status: ms < 200 ? '✅ PASS' : '❌ FAIL' };
  });
  console.log('\n=== File-system scan benchmark (grep fallback) ===');
  for (const row of fsScanTimes) {
    console.log(`Query: "${row.query}"`);
    console.log(`  Time: ${format(row.ms)}`);
    console.log(`  Status: ${row.status}`);
  }
  const fsSummary = summarize(fsScanTimes);
  console.log(`Average: ${format(fsSummary.avg)}`);
  console.log(`Max: ${format(fsSummary.max)}`);

  let semantic: Timing[] = [];
  let tuned: Timing[] = [];

  if (status.embedApiAvailable) {
    const resetStart = nowMs();
    embedReset(process.env);
    const resetMs = nowMs() - resetStart;

    const seedStart = nowMs();
    for (const doc of corpus.docs) {
      embedStore(doc.id, doc.text, process.env);
    }
    const seedMs = nowMs() - seedStart;

    console.log('\nEmbed seed:', {
      resetMs: Number(resetMs.toFixed(2)),
      seedMs: Number(seedMs.toFixed(2)),
      docsSeeded: corpus.docs.length,
    });

    semantic = measureQueries('Semantic search benchmark (embed_search)', (q) =>
      embedSearch(q, topK, process.env),
    );
    tuned = measureQueries('Semantic search benchmark (embed_search_tuned)', (q) =>
      embedSearchTuned(q, topK, process.env),
    );
  } else {
    console.log('\nSemantic search not available. Using fallback-only benchmark.');
  }

  const mem = process.memoryUsage();
  console.log('\nMemory usage:', {
    rssMb: mb(mem.rss),
    heapUsedMb: mb(mem.heapUsed),
    heapTotalMb: mb(mem.heapTotal),
    externalMb: mb(mem.external),
  });

  const semanticSummary = semantic.length ? summarize(semantic) : null;
  const tunedSummary = tuned.length ? summarize(tuned) : null;

  const summary = {
    targetMs: { ideal: 100, acceptable: 200 },
    semanticAvgMs: semanticSummary ? Number(semanticSummary.avg.toFixed(2)) : null,
    semanticMaxMs: semanticSummary ? Number(semanticSummary.max.toFixed(2)) : null,
    tunedAvgMs: tunedSummary ? Number(tunedSummary.avg.toFixed(2)) : null,
    tunedMaxMs: tunedSummary ? Number(tunedSummary.max.toFixed(2)) : null,
    fallbackFsAvgMs: Number(fsSummary.avg.toFixed(2)),
    fallbackFsMaxMs: Number(fsSummary.max.toFixed(2)),
    chainLoadMs: Number(chainLoad.ms.toFixed(2)),
    corpusSource,
    chainLoadSource: chainLoad.source,
    verdict:
      tunedSummary && tunedSummary.avg < 100
        ? '✅ IDEAL'
        : tunedSummary && tunedSummary.avg < 200
          ? '✅ ACCEPTABLE (alpha)'
          : tunedSummary
            ? '❌ FAIL (>200ms)'
            : fsSummary.avg < 200
              ? '✅ ACCEPTABLE fallback'
              : '❌ FAIL fallback (>200ms)',
  };

  console.log('\n=== FINAL SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
}

await main();
