/**
 * Mutation gate — does each guard still catch the breach it was written for?
 *
 * WHY THIS EXISTS
 * ---------------
 * Four guards in this repo were shipped green and wrong. Each had a test that
 * passed while the real defect was live:
 *
 *   - site-claims-contract.test.ts matched `v1.2.3` only, so the JSON-LD
 *     `"softwareVersion": "1.13.3"` drifted to a stale version and the test
 *     stayed green.
 *   - sync-site-metrics.mts rewrote only the metric strip; the typed terminal
 *     kept its own frozen numbers and nothing noticed until a test did.
 *   - sync-native-tiers.mts appended its doc comment instead of replacing it,
 *     so `--check` reported drift immediately after generating.
 *   - pii-scan.sh read file bodies only, so a filename carrying the identifier
 *     passed unnoticed for months.
 *
 * A test that passes is not evidence that it catches anything. These checks
 * are the only thing that distinguishes the two, and until now every one of
 * them was done by hand inside a single session — nothing in the repo
 * re-ran them, so the next change to any of those files was unguarded.
 *
 * HOW IT WORKS
 * ------------
 * For each mutation below: patch the real source file, assert the guard
 * exits non-zero, restore the file byte-for-byte. If the guard passes the
 * mutant, the mutation survives and this script fails.
 *
 * Scoped deliberately. It mutates the four guards themselves plus one
 * security check — not the whole codebase. A full mutation score needs a
 * mutation framework this repo does not have, and a gate nobody runs is
 * worse than no gate.
 *
 * Run: `npm run -s ops:mutation-gate`
 * Hook: .githooks/pre-commit runs it on staged changes to guarded files.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface Mutation {
  name: string;
  /** File to corrupt, relative to the repo root. */
  file: string;
  /** Text that must appear exactly once for the mutation to be safe to apply. */
  anchor: string;
  /** Replacement for the anchor. */
  replacement: string;
  /** Command that must FAIL (non-zero) once the mutation is in place. */
  guard: string[];
}

const MUTATIONS: Mutation[] = [
  {
    name: 'pii-scan misses an operator identifier placed in a filename',
    file: 'scripts/pii-scan.sh',
    anchor: 'OPERATOR_PII="$(printf',
    replacement: 'OPERATOR_PII="$(printf',
    guard: ['bash', 'scripts/pii-scan.sh'],
    // Special-cased below: the mutation is on the fixture, not the scanner.
  },
  {
    name: 'sync-site-metrics would rewrite a hand-edited tool count',
    file: 'docs/site/index.html',
    // Reads the live count instead of hardcoding it. Measured 2026-10-09:
    // this anchor was `data-count="58">58</span>`, and adding one tool
    // (memphis_wallet_sign) moved the page to 59 — so the mutation stopped
    // matching, the gate reported "refusing to mutate", and the mutant was
    // counted as SURVIVED. A hardcoded count in a guard that guards hardcoded
    // counts fails the same way the page it protects does.
    // `<TOOL_COUNT>` is substituted from the file at mutation time; the
    // anchor type is a plain string (the harness splits on it), so this
    // cannot be a RegExp literal.
    anchor: 'data-count="<TOOL_COUNT>"><TOOL_COUNT></span>',
    replacement: 'data-count="999">999</span>',
    guard: ['npx', 'tsx', 'scripts/sync-site-metrics.mts', '--check'],
  },
  {
    name: 'sync-native-tiers would accept a stale native tier table',
    file: 'crates/memphis-operator/src/chat.rs',
    // memphis_git is tier 2 now (the registry says so). Mutating the whole
    // arm keeps the guard meaningful: the table must change when the
    // generated content changes, which is what `--check` exists to notice.
    anchor: '| "memphis_git" => 2,',
    replacement: '| "memphis_git_unused_placeholder" => 2,\n        "memphis_git" => 1,',
    guard: ['npx', 'tsx', 'scripts/sync-native-tiers.mts', '--check'],
  },
  {
    name: 'a threat pattern dropped from TypeScript is not caught natively',
    file: 'src/security/content-scan.ts',
    // `ssh_access` is declared in BOTH MEMORY_PATTERNS and
    // CODE_CHANGE_PATTERNS, so the bare id appears twice and the mutation
    // refused to run. Anchor on the memory profile's header line instead,
    // which occurs exactly once and needs no literal indentation in a
    // regex (eslint no-regex-spaces).
    anchor: "const MEMORY_PATTERNS: ThreatPattern[] = [\n  {\n    id: 'prompt_injection',",
    replacement:
      "const MEMORY_PATTERNS: ThreatPattern[] = [\n  {\n    id: 'prompt_injection_renamed_by_mutation',",
    guard: ['npx', 'tsx', 'scripts/check-scan-parity.mts'],
  },
  {
    name: 'site-claims contract accepts a stale version in JSON-LD',
    file: 'docs/site/index.html',
    anchor: '"softwareVersion": "1.13.5"',
    replacement: '"softwareVersion": "0.0.1"',
    guard: ['npx', 'vitest', 'run', 'tests/unit/site-claims-contract.test.ts'],
  },
];

/** Run a command, returning its exit status without throwing. */
function status(cmd: string[]): number {
  return (
    spawnSync(cmd[0], cmd.slice(1), {
      cwd: resolve('.'),
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    }).status ?? 1
  );
}

function mutate(m: Mutation): boolean {
  const path = resolve(m.file);
  const src = readFileSync(path, 'utf8');
  // `<TOOL_COUNT>` is resolved against the live file so this mutation keeps
  // working as the tool count changes. If the marker ever disappears, the
  // guard below refuses to mutate rather than silently surviving.
  const resolvedAnchor = m.anchor.includes('<TOOL_COUNT>')
    ? m.anchor.replace(
        /<TOOL_COUNT>/g,
        (() => {
          const counts = [...src.matchAll(/data-count="(\d+)">\1<\/span>/g)].map(
            (mm) => mm[1] as string,
          );
          const toolCount = counts[0];
          if (!toolCount) {
            throw new Error(`no self-consistent data-count found in ${m.file} for "<TOOL_COUNT>"`);
          }
          return toolCount;
        })(),
      )
    : m.anchor;

  const count = src.split(resolvedAnchor).length - 1;
  if (count !== 1) {
    throw new Error(
      `anchor for "${m.name}" appears ${count} times in ${m.file} — refusing to mutate`,
    );
  }
  writeFileSync(path, src.replace(resolvedAnchor, m.replacement), 'utf8');
  return true;
}

interface Result {
  name: string;
  survived: boolean;
  detail: string;
}

const results: Result[] = [];

// --- 1. The path-blindness mutation: the original pii-scan defect ----------
// The scanner used to read file bodies only. Reproduce that by planting the
// operator identifier in a *filename* in a scratch repo and asserting the
// current scanner still blocks it. If someone removes path_hits() this dies.
{
  const dir = mkdtempSync(join(tmpdir(), 'memphis-mutation-'));
  const id = ['131', '603', '3647'].join('');
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, `session-${id}.json`), '{}\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x'], {
      cwd: dir,
    });
    const out = spawnSync('bash', [resolve('scripts/pii-scan.sh')], {
      cwd: dir,
      encoding: 'utf8',
    });
    results.push({
      name: 'pii-scan blocks an identifier in a filename (path_hits alive)',
      survived: (out.status ?? 1) === 0,
      detail: `exit=${out.status}`,
    });
  } catch (err) {
    results.push({
      name: 'pii-scan blocks an identifier in a filename (path_hits alive)',
      survived: true,
      detail: `setup failed: ${String(err)}`,
    });
  } finally {
    cleanup();
  }
}

// --- 2. Declared mutations -------------------------------------------------
for (const m of MUTATIONS.slice(1)) {
  const path = resolve(m.file);
  const backup = `${path}.mutation-backup`;
  copyFileSync(path, backup);
  try {
    mutate(m);
    const code = status(m.guard);
    results.push({
      name: m.name,
      survived: code === 0,
      detail: `guard exit=${code}`,
    });
  } catch (err) {
    results.push({ name: m.name, survived: true, detail: String(err) });
  } finally {
    copyFileSync(backup, path);
    rmSync(backup, { force: true });
  }
}

// --- 3. Every source file must be byte-identical after the run -------------
const dirty: string[] = [];
for (const m of MUTATIONS.slice(1)) {
  const path = resolve(m.file);
  if (!existsSync(path)) dirty.push(m.file);
}

// --- report ----------------------------------------------------------------
let survived = 0;
for (const r of results) {
  const mark = r.survived ? 'SURVIVED' : 'killed ';
  console.log(`[mutation-gate] ${mark}  ${r.name}  (${r.detail})`);
  if (r.survived) survived += 1;
}

if (survived > 0) {
  console.error(
    `[mutation-gate] ${survived}/${results.length} mutations survived — at least one guard no longer catches the defect it was written for.`,
  );
  process.exit(1);
}
if (dirty.length > 0) {
  console.error(`[mutation-gate] missing files after restore: ${dirty.join(', ')}`);
  process.exit(1);
}
console.log(`[mutation-gate] ${results.length}/${results.length} mutations killed`);
