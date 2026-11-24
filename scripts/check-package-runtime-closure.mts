/**
 * The packaged runtime's file closure: every file the shipped code loads from
 * OUTSIDE its own tree must be inside the npm tarball.
 *
 * WHY THIS EXISTS
 * ---------------
 * v1.14.0 did not publish. The `release` workflow failed on its first step,
 * and the reason was this, in one line:
 *
 *   [FAIL] package artifact validation failed: memphis completion bash:
 *   [ERROR] Failed to load Memphis CLI: Cannot find module
 *   '.../node_modules/@memphis-chains/memphis/scripts/backup-manifest.mjs'
 *   imported from '.../node_modules/@memphis-chains/memphis/dist/infra/cli/commands/backup-manifest.js'
 *
 * MEASURED 2026-11-23 on the operator's host, on the tagged commit
 * `34cb179074` (v1.14.0):
 *
 *   - `src/infra/cli/commands/backup-manifest.ts` imports
 *     `../../../../scripts/backup-manifest.mjs` — a file OUTSIDE `src/`;
 *   - `package.json`'s `files` listed `scripts/backup-db-snapshot.mjs` (the
 *     other such file) and NOT `scripts/backup-manifest.mjs`;
 *   - npm's own file list (`npm pack --dry-run --json`) published
 *     `dist/infra/cli/commands/backup-manifest.js` and omitted
 *     `scripts/backup-manifest.mjs`.
 *
 * The import is a MODULE-LOAD-TIME import, so the omission did not break one
 * command — it broke EVERY command. `memphis completion bash` was simply the
 * first one the validator ran.
 *
 * The defect was introduced by `f4b9bc2875` ("fix(contract): the manifest is
 * one index of the archives on disk"), which added the command and the
 * module but did not add the module to `files`. `package.json` had never
 * listed it: `git log -S"scripts/backup-manifest.mjs" -- package.json` is
 * empty.
 *
 * WHY A GATE AND NOT A FIXED LIST
 * --------------------------------
 * Adding the one missing path would fix v1.14.0 and leave the next
 * `scripts/foo.mjs` import exactly as invisible. The list in `files` is a
 * denylist of omissions, and a denylist nobody checks is a wish.
 *
 * So the rule is INVERTED: the edges are discovered, and every edge must be
 * covered. A new cross-boundary import cannot be published without either
 * (a) listing its target in `files`, or (b) failing this gate.
 *
 * THE HOUSE PATTERN
 * -----------------
 *   - ONE owner: this script — it discovers the edges and produces the
 *     verdict. Nothing else re-implements the discovery;
 *   - ONE artefact of cases: `tests/fixtures/package-runtime-closure.json` —
 *     the cross-boundary edges, generated, never hand-written;
 *   - TWO runners: this script (`npm run -s ops:check-package-runtime-closure`,
 *     and `--check` in CI) and `tests/ops/package-runtime-closure.test.ts`.
 *     Both read the artefact; neither produces it alone.
 *
 * WHAT COUNTS AS AN EDGE
 * -----------------------
 * A static relative specifier (`./`, `../`) in a file that the package
 * ships, whose target resolves OUTSIDE the tree that file lives in. The
 * scanned roots are:
 *
 *   - `src/` — the source of everything under `dist/`. `tsc` preserves
 *     relative specifiers verbatim, so the compiled tree carries the same
 *     edges; scanning `src/` needs no build, which is what lets this gate
 *     run in seconds inside the preflight;
 *   - `bin/` — hand-written JavaScript that npm ships;
 *   - every `scripts/*` entry in `files` — shipped scripts that may import
 *     a sibling.
 *
 * DYNAMIC imports (`await import(someVariable)`) are NOT seen by this gate;
 * the end-to-end proof that the tarball actually runs is
 * `scripts/validate-package-artifact.mts` (`ops:validate-package-artifact`),
 * which packs, installs and executes the real binary. This gate is the fast
 * one; that one is the slow one. Both belong in the release path.
 *
 * THE VERDICT
 * -----------
 * An edge's target must be listed in `package.json`'s `files` BY EXACT PATH.
 * Exact paths, not globs: a glob would make the published set depend on npm's
 * matcher, and this gate's whole point is to be a second, independent witness
 * of what npm will publish. `npm pack --dry-run` is that other witness, and
 * `ops:validate-package-artifact` is the third.
 *
 * Usage:
 *   npm run -s ops:check-package-runtime-closure            # regenerate the artefact
 *   npm run -s ops:check-package-runtime-closure -- --check # fail on drift
 *   npm run -s ops:check-package-runtime-closure -- --json
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * A static relative import whose target leaves the tree the importer lives in.
 *
 * `resolved` is repo-relative and POSIX-shaped, so the artefact is the same
 * on every platform.
 */
export type RuntimeEdge = {
  /** Repo-relative path of the importing file. */
  importer: string;
  /** The specifier as written in the source. */
  specifier: string;
  /** Repo-relative path of the imported file. */
  resolved: string;
};

/**
 * The artefact: the cross-boundary edges, and nothing else.
 *
 * `schemaVersion` is bumped when the shape changes, so a runner that reads an
 * older artefact fails loudly instead of reading a field that moved.
 */
export type RuntimeClosureArtifact = {
  schemaVersion: number;
  edges: RuntimeEdge[];
};

export const RUNTIME_CLOSURE_SCHEMA_VERSION = 1;

/** The roots that ship in the tarball and may reach outside themselves. */
const SCAN_ROOTS = ['src', 'bin'] as const;

/**
 * Static relative specifiers.
 *
 * Matches `from '...'`, `import '...'`, `import('...')` and `require('...')`.
 * Only relative specifiers are considered — a bare package specifier is
 * resolved from `node_modules`, which npm installs for the consumer.
 */
const SPECIFIER_PATTERN = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g;

const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..');

export const ARTIFACT_PATH = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'package-runtime-closure.json',
);

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/**
 * List every source file under `dir`, skipping build and dependency trees.
 */
function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const found: string[] = [];
  const stack: string[] = [dir];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        found.push(absolute);
      }
    }
  }

  return found.sort();
}

/**
 * Resolve a relative specifier to a file on disk.
 *
 * TypeScript sources import with the extension they want at runtime
 * (`./foo.js`), but a specifier without an extension is legal too, so the
 * common extensions are tried. Returns `null` when nothing matches — that is
 * a broken import, which the caller reports as its own kind of failure.
 */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);

  if (existsSync(base) && statSync(base).isFile()) {
    return base;
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate)) return candidate;
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = path.join(base, `index${extension}`);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Discover every cross-boundary edge in the shipped code.
 *
 * An edge is a static relative import whose target lives outside the
 * importer's own root directory (`src/` or `bin/`). An import that stays
 * inside the tree is already covered by the tree being published whole.
 */
export function collectRuntimeEdges(roots: readonly string[] = SCAN_ROOTS): RuntimeEdge[] {
  const edges: RuntimeEdge[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const rootDir = path.join(repoRoot, root);
    for (const file of listSourceFiles(rootDir)) {
      const source = readFileSync(file, 'utf8');
      SPECIFIER_PATTERN.lastIndex = 0;

      let match: RegExpExecArray | null = SPECIFIER_PATTERN.exec(source);
      while (match !== null) {
        const specifier = match[1];
        const resolved = resolveSpecifier(file, specifier);

        if (resolved !== null) {
          const relative = path.relative(repoRoot, resolved);
          const insideRoot = relative === root || relative.startsWith(`${root}${path.sep}`);

          if (!insideRoot) {
            const edge: RuntimeEdge = {
              importer: toPosix(path.relative(repoRoot, file)),
              specifier,
              resolved: toPosix(relative),
            };
            const key = `${edge.importer} ${edge.specifier} ${edge.resolved}`;
            if (!seen.has(key)) {
              seen.add(key);
              edges.push(edge);
            }
          }
        }

        match = SPECIFIER_PATTERN.exec(source);
      }
    }
  }

  return edges.sort((left, right) =>
    left.resolved === right.resolved
      ? left.importer.localeCompare(right.importer)
      : left.resolved.localeCompare(right.resolved),
  );
}

/**
 * The paths `package.json` publishes, as written by hand.
 *
 * This is the list the verdict is measured against, and it is read from the
 * manifest itself rather than from a copy — the manifest is the only place
 * that decides what npm publishes.
 */
export function readDeclaredPackageFiles(): string[] {
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as { files?: string[] };

  return Array.isArray(manifest.files) ? manifest.files : [];
}

/**
 * The verdict: which edges are not covered by the published manifest.
 */
export function findUncoveredEdges(
  edges: readonly RuntimeEdge[],
  declaredFiles: readonly string[] = readDeclaredPackageFiles(),
): RuntimeEdge[] {
  const declared = new Set(declaredFiles.map((entry) => toPosix(entry).replace(/^\.\//, '')));

  return edges.filter((edge) => !declared.has(edge.resolved));
}

function buildArtifact(edges: readonly RuntimeEdge[]): RuntimeClosureArtifact {
  return {
    schemaVersion: RUNTIME_CLOSURE_SCHEMA_VERSION,
    edges: [...edges],
  };
}

function artifactsEqual(left: RuntimeClosureArtifact, right: RuntimeClosureArtifact): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type Options = {
  check: boolean;
  json: boolean;
};

function usage(): string {
  return [
    'Usage: npm run -s ops:check-package-runtime-closure -- [--check] [--json]',
    '',
    'Options:',
    '  --check  Fail when the artefact differs from the discovered edges (CI mode)',
    '  --json   Emit machine-readable output',
  ].join('\n');
}

function parseArgs(argv: string[]): Options {
  const options: Options = { check: false, json: false };

  for (const argument of argv) {
    if (argument === '--check') {
      options.check = true;
      continue;
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--help') {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return options;
}

type Summary = {
  schemaVersion: number;
  ok: boolean;
  artifactPath: string;
  edges: RuntimeEdge[];
  uncovered: RuntimeEdge[];
  declaredFiles: string[];
  drift: boolean;
  error: string | null;
};

function main(argv: string[]): number {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[FAIL] package runtime closure check: ${(error as Error).message}`);
    return 2;
  }

  const summary: Summary = {
    schemaVersion: RUNTIME_CLOSURE_SCHEMA_VERSION,
    ok: false,
    artifactPath: ARTIFACT_PATH,
    edges: [],
    uncovered: [],
    declaredFiles: [],
    drift: false,
    error: null,
  };

  try {
    const edges = collectRuntimeEdges();
    const declaredFiles = readDeclaredPackageFiles();
    const uncovered = findUncoveredEdges(edges, declaredFiles);
    const computed = buildArtifact(edges);

    const stored = existsSync(ARTIFACT_PATH)
      ? (JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as RuntimeClosureArtifact)
      : null;

    const drift = stored === null || !artifactsEqual(stored, computed);

    summary.edges = edges;
    summary.uncovered = uncovered;
    summary.declaredFiles = declaredFiles;
    summary.drift = drift;

    if (!options.check) {
      writeFileSync(ARTIFACT_PATH, `${JSON.stringify(computed, null, 2)}\n`, 'utf8');
    }

    const problems: string[] = [];
    for (const edge of uncovered) {
      problems.push(
        `the packaged runtime imports '${edge.resolved}' (from ${edge.importer}), ` +
          `but package.json "files" does not list it — the tarball would ship a ` +
          `module that cannot be loaded`,
      );
    }
    if (options.check && drift) {
      problems.push(
        'the artefact tests/fixtures/package-runtime-closure.json differs from the ' +
          'discovered edges — regenerate it with: npm run -s ops:check-package-runtime-closure',
      );
    }

    summary.ok = problems.length === 0;
    summary.error = problems.length > 0 ? problems.join('; ') : null;

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else if (summary.ok) {
      console.log(
        `[PASS] package runtime closure: ${edges.length} cross-boundary edge(s), all covered by package.json "files"`,
      );
    } else {
      console.error(`[FAIL] package runtime closure check: ${summary.error}`);
    }

    return summary.ok ? 0 : 1;
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.error(`[FAIL] package runtime closure check: ${summary.error}`);
    }
    return 1;
  }
}

/**
 * Run the CLI only when this file IS the entry point.
 *
 * The vitest runner imports the owner above to reuse `collectRuntimeEdges`
 * and `findUncoveredEdges` — importing must not run the gate, and must not
 * call `process.exit()` inside the test runner.
 */
const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entryPoint === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
