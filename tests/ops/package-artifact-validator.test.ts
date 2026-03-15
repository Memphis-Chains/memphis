import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

type OutputContract = {
  schemaVersion: number;
  summaryTopLevelKeys: string[];
  cliProbeTopLevelKeys: string[];
  requiredEntries: string[];
  cliProbeCommand: string;
  cliProbeStdoutFirstLine: string;
};

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const outputContractPath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'release-draft',
  'package-artifact-validator-output-contract.json',
);

let packedArtifactDir: string | null = null;
let packedArtifactPath: string | null = null;

function ensurePackedArtifactPath(): string {
  if (packedArtifactPath) {
    return packedArtifactPath;
  }

  packedArtifactDir = mkdtempSync(path.join(tmpdir(), 'memphis-package-artifact-test-'));
  const packResult = spawnSync('npm', ['pack', '--pack-destination', packedArtifactDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 300_000,
  });

  if (packResult.error) {
    throw packResult.error;
  }
  if (packResult.status !== 0) {
    throw new Error(packResult.stderr.trim() || packResult.stdout.trim() || 'npm pack failed');
  }

  const artifactName = packResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.endsWith('.tgz'));
  if (!artifactName) {
    throw new Error('npm pack did not report a .tgz artifact');
  }

  packedArtifactPath = path.join(packedArtifactDir, artifactName);
  return packedArtifactPath;
}

function runPackageArtifactValidator(args: string[]) {
  return spawnSync('npm', ['run', '-s', 'ops:validate-package-artifact', '--', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 300_000,
  });
}

afterAll(() => {
  if (packedArtifactDir) {
    rmSync(packedArtifactDir, { recursive: true, force: true });
  }
});

describe('ops:validate-package-artifact', () => {
  it('validates the packed MemphisOS tarball and packaged CLI entrypoint', () => {
    const artifactPath = ensurePackedArtifactPath();
    const result = runPackageArtifactValidator(['--artifact-path', artifactPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[PASS] package artifact validated:');
    expect(result.stdout).toContain(path.basename(artifactPath));
  }, 120_000);

  it('fails closed when the requested artifact path does not exist', () => {
    const missingArtifactPath = path.join(tmpdir(), 'memphis-package-artifact-missing.tgz');
    const result = runPackageArtifactValidator(['--artifact-path', missingArtifactPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[FAIL] package artifact validation failed:');
    expect(result.stderr).toContain(`artifact not found: ${missingArtifactPath}`);
  });

  it('emits stable machine-readable output in --json mode', () => {
    const artifactPath = ensurePackedArtifactPath();
    const result = runPackageArtifactValidator(['--artifact-path', artifactPath, '--json']);
    const contract = JSON.parse(readFileSync(outputContractPath, 'utf8')) as OutputContract;

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion: number;
      ok: boolean;
      artifactPath: string;
      artifactName: string;
      requiredEntries: string[];
      cliProbe: {
        command: string;
        ok: boolean;
        exitCode: number;
        stdoutFirstLine: string | null;
        stderrFirstLine: string | null;
      } | null;
      error: string | null;
    };

    expect(parsed.schemaVersion).toBe(contract.schemaVersion);
    expect(Object.keys(parsed).sort()).toEqual([...contract.summaryTopLevelKeys].sort());
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect(parsed.artifactName).toBe(path.basename(artifactPath));
    expect(parsed.requiredEntries).toEqual(contract.requiredEntries);
    expect(parsed.cliProbe).not.toBeNull();
    expect(Object.keys(parsed.cliProbe ?? {}).sort()).toEqual(
      [...contract.cliProbeTopLevelKeys].sort(),
    );
    expect(parsed.cliProbe?.command).toBe(contract.cliProbeCommand);
    expect(parsed.cliProbe?.ok).toBe(true);
    expect(parsed.cliProbe?.exitCode).toBe(0);
    expect(parsed.cliProbe?.stdoutFirstLine).toBe(contract.cliProbeStdoutFirstLine);
    expect(parsed.cliProbe?.stderrFirstLine).toBeNull();
  }, 120_000);
});
