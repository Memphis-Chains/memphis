import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

type CliProbeSummary = {
  command: string;
  ok: boolean;
  exitCode: number;
  stdoutFirstLine: string | null;
  stderrFirstLine: string | null;
};

type ValidationSummary = {
  schemaVersion: 4;
  ok: boolean;
  artifactPath: string | null;
  artifactName: string | null;
  validatedSurface: 'bounded-cli-distribution';
  deferredRuntimeProofs: string[];
  requiredEntries: string[];
  cliProbes: CliProbeSummary[];
  /**
   * The install policy the gate used, and the native binding it proved.
   *
   * npm 12 blocks dependency install scripts by default, and it reads the
   * `allowScripts` field from the PROJECT ROOT — not from the package being
   * installed. Measured 2026-11-24 on this host against the published
   * v1.14.1 tarball: `better-sqlite3` ships no prebuilt binding, so with the
   * script blocked the CLI dies at startup with "Could not locate the
   * bindings file" — and the old gate did not notice, because it installed
   * with `--ignore-scripts` and probed only the two commands that never
   * open the journal database.
   *
   * So the gate now states the policy it installs under, and proves the
   * binding that policy is supposed to produce.
   */
  installPolicy: {
    allowScripts: Record<string, boolean>;
    onnxruntimeCuda: 'skip';
    nativeBinding: string | null;
  };
  error: string | null;
};

type Options = {
  json: boolean;
  artifactPath: string | null;
};

const requiredEntries = [
  'package/package.json',
  'package/bin/memphis.js',
  'package/dist/infra/cli/index.js',
  'package/README.md',
  'package/LICENSE',
];

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..');

function usage(): string {
  return [
    'Usage: npm run -s ops:validate-package-artifact -- [--artifact-path <path>] [--json]',
    '',
    'Options:',
    '  --artifact-path <path>  Validate an existing package tarball instead of packing the repo',
    '  --json                  Emit machine-readable validation output',
  ].join('\n');
}

function parseArgs(argv: string[]): Options {
  const options: Options = { json: false, artifactPath: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--artifact-path') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--artifact-path requires a value');
      }
      options.artifactPath = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function firstLine(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.split(/\r?\n/, 1)[0] ?? null;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, ...extraEnv },
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function resolveArtifactPath(existingArtifactPath: string | null, tempDirs: string[]): string {
  if (existingArtifactPath) {
    if (!existsSync(existingArtifactPath)) {
      throw new Error(`artifact not found: ${existingArtifactPath}`);
    }
    return existingArtifactPath;
  }

  const packDir = mkdtempSync(path.join(tmpdir(), 'memphis-package-artifact-pack-'));
  tempDirs.push(packDir);
  const packResult = run('npm', ['pack', '--pack-destination', packDir], repoRoot);
  if (packResult.status !== 0) {
    throw new Error(
      firstLine(packResult.stderr) ?? firstLine(packResult.stdout) ?? 'npm pack failed',
    );
  }

  const artifactName = readdirSync(packDir).find((entry) => entry.endsWith('.tgz'));
  if (!artifactName) {
    throw new Error(`npm pack did not produce a .tgz artifact in ${packDir}`);
  }

  return path.join(packDir, artifactName);
}

function validateEntries(extractDir: string): void {
  for (const requiredEntry of requiredEntries) {
    const absolutePath = path.join(extractDir, requiredEntry);
    if (!existsSync(absolutePath)) {
      throw new Error(`required package entry missing: ${requiredEntry}`);
    }
  }
}

/**
 * The install scripts a consumer has to approve, and nothing else.
 *
 * npm 12 (measured on this host: npm 12.0.2) blocks dependency install
 * scripts by default and reads `allowScripts` from the PROJECT ROOT only —
 * a published package's own `allowScripts` field does not travel with it
 * (the installed `node_modules/@memphis-chains/memphis/package.json` carried
 * `{"better-sqlite3": true, ...}` and the script was still blocked).
 *
 * `better-sqlite3` is the only dependency that MUST run its install script:
 * it ships no prebuilt binding, it downloads one (`prebuild-install`) or
 * compiles it. Everything else in the dependency tree either ships its
 * binary inside the package (`onnxruntime-node` ships the CPU runtime) or
 * is not needed at runtime.
 */
const CONSUMER_ALLOW_SCRIPTS: Record<string, boolean> = {
  'better-sqlite3': true,
};

function installArtifactIntoPrefix(artifactPath: string, prefixDir: string): void {
  // The prefix is its own npm PROJECT, because npm reads `allowScripts`
  // from the project's package.json — `--prefix` only moves where the
  // packages land, not which project rules apply.
  writeFileSync(
    path.join(prefixDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'memphis-package-artifact-probe',
        version: '1.0.0',
        private: true,
        allowScripts: allowedScriptPolicy(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run(
    'npm',
    ['install', '--no-package-lock', '--no-fund', '--no-audit', artifactPath],
    prefixDir,
    {
      // `onnxruntime-node`'s install script downloads the CUDA build, and
      // that asset answers 404 — which aborts the whole install. The CPU
      // runtime ships inside the package, so the script is not needed for
      // it. The repository's own `.npmrc` says the same thing; a
      // dependency's `.npmrc` is not read by npm, so the gate says it.
      npm_config_onnxruntime_node_install_cuda: 'skip',
    },
  );

  if (result.status !== 0) {
    throw new Error(
      firstLine(result.stderr) ??
        firstLine(result.stdout) ??
        'npm install of package artifact failed',
    );
  }
}

/**
 * Prove that the install produced the native binding the CLI needs.
 *
 * This is the assertion the old gate was missing: it installed with
 * `--ignore-scripts`, so `better-sqlite3` had no binding, and the two
 * probes it ran (`--help`, `completion bash`) never open the journal
 * database — so the gate passed on a package that could not start.
 */
function resolveNativeBinding(prefixDir: string): string {
  const sqliteDir = path.join(prefixDir, 'node_modules', 'better-sqlite3');
  const candidates = [
    path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node'),
    path.join(sqliteDir, 'prebuilds', 'better_sqlite3.node'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    'the installed package has no better-sqlite3 native binding — the install ' +
      'did not run the script that builds it. A consumer needs ' +
      `"allowScripts": ${JSON.stringify(allowedScriptPolicy())} in their project.`,
  );
}

/** The approvals a consumer actually needs — only the ones set to true. */
function allowedScriptPolicy(): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(CONSUMER_ALLOW_SCRIPTS).filter(([, allowed]) => allowed),
  );
}

function resolveInstalledBinary(prefixDir: string): string {
  const candidates = [
    path.join(prefixDir, 'bin', 'memphis'),
    path.join(prefixDir, 'node_modules', '.bin', 'memphis'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`installed memphis binary not found under ${prefixDir}`);
}

type CliProbeSpec = {
  command: string;
  args: string[];
  validate: (stdout: string, summary: CliProbeSummary) => void;
};

function createProbeEnv(prefixDir: string, extractDir: string): NodeJS.ProcessEnv {
  return {
    PATH: `${path.join(prefixDir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    SystemRoot: process.env.SystemRoot,
    NODE_NO_WARNINGS: '1',
    NODE_ENV: 'test',
    RUST_CHAIN_ENABLED: 'false',
    DEFAULT_PROVIDER: 'local-fallback',
    MEMPHIS_SKIP_FIRST_RUN_CHECKS: '1',
    // A fresh installation must use its own config and transaction journals.
    MEMPHIS_ENV_FILE: path.join(extractDir, '.env'),
    MEMPHIS_DATA_DIR: path.join(extractDir, 'data'),
  };
}

function runCliProbe(
  prefixDir: string,
  extractDir: string,
  binaryPath: string,
  probe: CliProbeSpec,
): CliProbeSummary {
  const result = spawnSync(binaryPath, probe.args, {
    cwd: prefixDir,
    encoding: 'utf8',
    timeout: 120_000,
    env: createProbeEnv(prefixDir, extractDir),
  });

  if (result.error) {
    throw result.error;
  }

  const summary: CliProbeSummary = {
    command: probe.command,
    ok: result.status === 0,
    exitCode: result.status ?? 1,
    stdoutFirstLine: firstLine(result.stdout),
    stderrFirstLine: firstLine(result.stderr),
  };

  if (!summary.ok) {
    throw new Error(
      `${probe.command}: ${summary.stderrFirstLine ?? summary.stdoutFirstLine ?? 'packaged CLI probe failed'}`,
    );
  }

  probe.validate(result.stdout, summary);

  return summary;
}

function runCliProbes(prefixDir: string, extractDir: string): CliProbeSummary[] {
  const binaryPath = resolveInstalledBinary(prefixDir);
  const probes: CliProbeSpec[] = [
    {
      command: 'memphis completion bash',
      args: ['completion', 'bash'],
      validate: (_stdout, summary) => {
        if (summary.stdoutFirstLine !== '# bash completion for memphis') {
          throw new Error(
            `unexpected packaged CLI probe output for ${summary.command}: ${summary.stdoutFirstLine ?? '<empty>'}`,
          );
        }
      },
    },
    {
      command: 'memphis --help',
      args: ['--help'],
      validate: (_stdout, summary) => {
        if (summary.stdoutFirstLine !== 'usage: memphis <command> [--json]') {
          throw new Error(
            `unexpected packaged CLI probe output for ${summary.command}: ${summary.stdoutFirstLine ?? '<empty>'}`,
          );
        }
      },
    },
    {
      // The probe that opens the journal DATABASE. `--help` and
      // `completion bash` never touch it, which is why the old gate passed
      // on a package whose native binding was never built.
      command: 'memphis vault list --json',
      args: ['vault', 'list', '--json'],
      validate: (stdout, summary) => {
        if (!stdout.includes('"ok": true')) {
          throw new Error(
            `unexpected packaged CLI probe output for ${summary.command}: ${summary.stdoutFirstLine ?? '<empty>'}`,
          );
        }
      },
    },
  ];

  return probes.map((probe) => runCliProbe(prefixDir, extractDir, binaryPath, probe));
}

function print(summary: ValidationSummary, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (summary.ok) {
    console.log(
      `[PASS] package artifact validated: ${summary.artifactName} (${summary.validatedSurface})`,
    );
  } else {
    console.error(`[FAIL] package artifact validation failed: ${summary.error}`);
  }
}

const tempDirs: string[] = [];

/**
 * Remove every temp dir this run created, then clear the list.
 *
 * Idempotent on purpose: both exit paths call this before `process.exit()`
 * (which does not unwind `finally`), and the `finally` block calls it again.
 * A second pass over an empty list is a no-op, and `force: true` means a dir
 * already gone does not throw.
 */
function cleanupTempDirs(): void {
  for (const tempDir of tempDirs.splice(0)) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // A temp dir we cannot remove must not mask the validator's own
      // exit code. The real failure is reported by the caller.
    }
  }
}
let summary: ValidationSummary = {
  schemaVersion: 4,
  ok: false,
  artifactPath: null,
  artifactName: null,
  validatedSurface: 'bounded-cli-distribution',
  deferredRuntimeProofs: ['rust-tui-source-checkout'],
  requiredEntries: [...requiredEntries],
  cliProbes: [],
  installPolicy: {
    allowScripts: allowedScriptPolicy(),
    onnxruntimeCuda: 'skip',
    nativeBinding: null,
  },
  error: null,
};
let options: Options = { json: false, artifactPath: null };

try {
  options = parseArgs(process.argv.slice(2));
  const artifactPath = resolveArtifactPath(options.artifactPath, tempDirs);
  const extractDir = mkdtempSync(path.join(tmpdir(), 'memphis-package-artifact-extract-'));
  tempDirs.push(extractDir);
  const installPrefix = mkdtempSync(path.join(tmpdir(), 'memphis-package-artifact-prefix-'));
  tempDirs.push(installPrefix);
  const extractResult = run('tar', ['-xzf', artifactPath, '-C', extractDir], repoRoot);
  if (extractResult.status !== 0) {
    throw new Error(
      firstLine(extractResult.stderr) ?? firstLine(extractResult.stdout) ?? 'tar extraction failed',
    );
  }

  validateEntries(extractDir);
  installArtifactIntoPrefix(artifactPath, installPrefix);
  const nativeBinding = resolveNativeBinding(installPrefix);
  const cliProbes = runCliProbes(installPrefix, extractDir);

  summary = {
    ...summary,
    ok: true,
    artifactPath,
    artifactName: path.basename(artifactPath),
    cliProbes,
    installPolicy: {
      allowScripts: allowedScriptPolicy(),
      onnxruntimeCuda: 'skip',
      nativeBinding,
    },
  };
  print(summary, options.json);
  // process.exit() does not unwind `finally` — Node tears the process down
  // before the cleanup block runs. Cleanup explicitly, then exit.
  cleanupTempDirs();
  process.exit(0);
} catch (error) {
  summary = {
    ...summary,
    artifactPath: options.artifactPath,
    artifactName: options.artifactPath ? path.basename(options.artifactPath) : null,
    error: error instanceof Error ? error.message : String(error),
  };
  print(summary, options.json);
  // Same reason as the success path: exit skips the finally block.
  cleanupTempDirs();
  process.exit(
    summary.error?.startsWith('Unknown option:') || summary.error?.includes('requires a value')
      ? 2
      : 1,
  );
} finally {
  cleanupTempDirs();
}
