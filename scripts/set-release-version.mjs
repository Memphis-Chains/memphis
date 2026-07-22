#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/set-release-version.mjs <semver>');
  process.exit(1);
}

function writeJson(path, mutate) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  mutate(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceExactlyOnce(path, pattern, replacement) {
  const original = readFileSync(path, 'utf8');
  const matches = original.match(pattern);
  if (matches?.length !== 1) {
    throw new Error(
      `${path}: expected exactly one public version marker, found ${matches?.length ?? 0}`,
    );
  }
  writeFileSync(path, original.replace(pattern, replacement));
}

writeJson('package.json', (pkg) => {
  pkg.version = version;
});

writeJson('npm-shrinkwrap.json', (lock) => {
  lock.version = version;
  if (!lock.packages?.['']) {
    throw new Error('npm-shrinkwrap.json: missing root package metadata');
  }
  lock.packages[''].version = version;
});

replaceExactlyOnce(
  'README.md',
  /(?<=\*\*Current version: `v)\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?(?=`\*\*)/g,
  version,
);
replaceExactlyOnce(
  'README.pl.md',
  /(?<=\*\*Wersja:\*\* `v)\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?(?=`)/g,
  version,
);

console.log(`Synchronized public release version to v${version}.`);
