import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
  schemaVersion: 3;
  ok: boolean;
  artifactPath: string | null;
  artifactName: string | null;
  validatedSurface: 'bounded-cli-distribution';
  deferredRuntimeProofs: string[];
  requiredEntries: string[];
  cliProbes: CliProbeSummary[];
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

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
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

function installArtifactIntoPrefix(artifactPath: string, prefixDir: string): void {
  const result = run(
    'npm',
    [
      'install',
      '--prefix',
      prefixDir,
      '--ignore-scripts',
      '--no-package-lock',
      '--no-fund',
      '--no-audit',
      artifactPath,
    ],
    repoRoot,
  );

  if (result.status !== 0) {
    throw new Error(
      firstLine(result.stderr) ?? firstLine(result.stdout) ?? 'npm install of package artifact failed',
    );
  }
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
    ...process.env,
    PATH: `${path.join(prefixDir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    NODE_NO_WARNINGS: '1',
    NODE_ENV: 'test',
    DEFAULT_PROVIDER: 'local-fallback',
    MEMPHIS_SKIP_FIRST_RUN_CHECKS: '1',
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
      command: 'memphis health --json',
      args: ['health', '--json'],
      validate: (stdout) => {
        let parsed: { status?: string; service?: string };
        try {
          parsed = JSON.parse(stdout) as { status?: string; service?: string };
        } catch (error) {
          throw new Error(
            `memphis health --json emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (parsed.status !== 'ok' || parsed.service !== 'memphis') {
          throw new Error(
            `memphis health --json returned unexpected payload: ${JSON.stringify(parsed)}`,
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
let summary: ValidationSummary = {
  schemaVersion: 3,
  ok: false,
  artifactPath: null,
  artifactName: null,
  validatedSurface: 'bounded-cli-distribution',
  deferredRuntimeProofs: ['rust-tui-source-checkout'],
  requiredEntries: [...requiredEntries],
  cliProbes: [],
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
  const cliProbes = runCliProbes(installPrefix, extractDir);

  summary = {
    ...summary,
    ok: true,
    artifactPath,
    artifactName: path.basename(artifactPath),
    cliProbes,
  };
  print(summary, options.json);
  process.exit(0);
} catch (error) {
  summary = {
    ...summary,
    artifactPath: options.artifactPath,
    artifactName: options.artifactPath ? path.basename(options.artifactPath) : null,
    error: error instanceof Error ? error.message : String(error),
  };
  print(summary, options.json);
  process.exit(
    summary.error?.startsWith('Unknown option:') || summary.error?.includes('requires a value')
      ? 2
      : 1,
  );
} finally {
  for (const tempDir of tempDirs) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
