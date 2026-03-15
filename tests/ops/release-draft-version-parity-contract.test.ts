import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type ReleaseDraftVersionParityContract = {
  workflowPath: string;
  packageJsonPath: string;
  expectedTagTemplate: string;
  expectedAssetNameTemplate: string;
  packageMetadataMarkers: string[];
  versionGuardMarkers: string[];
  versionErrorMarkers: string[];
  assetGuardMarkers: string[];
  assetErrorMarkers: string[];
  tagMarkers: string[];
  outputMarkers?: string[];
  summaryMarkers?: string[];
  versionGuardMustPrecedeMarkers: string[];
  assetGuardMustPrecedeMarkers: string[];
};

type PackageManifest = {
  name: string;
  version: string;
};

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const fixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'release-draft',
  'version-parity-contract.json',
);

function toPackageSlug(packageName: string): string {
  return packageName.replace(/^@/, '').replace(/\//g, '-');
}

function renderTemplate(
  template: string,
  values: Record<'packageSlug' | 'packageVersion', string>,
): string {
  return template.replace(/\{\{(packageSlug|packageVersion)\}\}/g, (_, key) => values[key]);
}

function expectMarkers(haystack: string, markers: string[], label: string): void {
  for (const marker of markers) {
    expect(haystack, `${label} marker is missing: ${marker}`).toContain(marker);
  }
}

function expectMarkerBefore(haystack: string, marker: string, sentinel: string): void {
  const markerIndex = haystack.indexOf(marker);
  const sentinelIndex = haystack.indexOf(sentinel);

  expect(markerIndex, `missing marker: ${marker}`).toBeGreaterThanOrEqual(0);
  expect(sentinelIndex, `missing sentinel: ${sentinel}`).toBeGreaterThanOrEqual(0);
  expect(
    markerIndex,
    `expected marker to fail-close before sentinel:\nmarker: ${marker}\nsentinel: ${sentinel}`,
  ).toBeLessThan(sentinelIndex);
}

describe('release-draft version parity contract', () => {
  const contract = JSON.parse(
    readFileSync(fixturePath, 'utf8'),
  ) as ReleaseDraftVersionParityContract;
  const workflowPath = path.join(repoRoot, contract.workflowPath);
  const packageJsonPath = path.join(repoRoot, contract.packageJsonPath);
  const workflow = readFileSync(workflowPath, 'utf8');
  const packageManifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageManifest;
  const packageSlug = toPackageSlug(packageManifest.name);
  const expectedTag = renderTemplate(contract.expectedTagTemplate, {
    packageSlug,
    packageVersion: packageManifest.version,
  });
  const expectedAssetName = renderTemplate(contract.expectedAssetNameTemplate, {
    packageSlug,
    packageVersion: packageManifest.version,
  });

  it('fail-closes on VERSION/package.json mismatches before pack or release steps run', () => {
    expect(existsSync(workflowPath)).toBe(true);
    expect(existsSync(packageJsonPath)).toBe(true);
    expect(packageManifest.version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$/);
    expect(expectedTag).toBe(`v${packageManifest.version}`);

    expectMarkers(workflow, contract.packageMetadataMarkers, 'package metadata');
    expectMarkers(workflow, contract.versionGuardMarkers, 'version guard');
    expectMarkers(workflow, contract.versionErrorMarkers, 'version guard error');

    for (const marker of [...contract.versionGuardMarkers, ...contract.versionErrorMarkers]) {
      for (const sentinel of contract.versionGuardMustPrecedeMarkers) {
        expectMarkerBefore(workflow, marker, sentinel);
      }
    }
  });

  it('fail-closes on packed asset mismatches and surfaces aligned tag/artifact markers', () => {
    expect(expectedAssetName).toBe(`${packageSlug}-${packageManifest.version}.tgz`);
    expect(expectedAssetName).toContain(`-${packageManifest.version}.tgz`);

    expectMarkers(workflow, contract.assetGuardMarkers, 'asset guard');
    expectMarkers(workflow, contract.assetErrorMarkers, 'asset guard error');
    expectMarkers(workflow, contract.tagMarkers, 'tag');
    expectMarkers(workflow, contract.outputMarkers ?? [], 'output');
    expectMarkers(workflow, contract.summaryMarkers ?? [], 'summary');

    for (const marker of [...contract.assetGuardMarkers, ...contract.assetErrorMarkers]) {
      for (const sentinel of contract.assetGuardMustPrecedeMarkers) {
        expectMarkerBefore(workflow, marker, sentinel);
      }
    }
  });
});
