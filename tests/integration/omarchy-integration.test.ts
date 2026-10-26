import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { applyOmarchyIntegration, planOmarchyIntegration, uninstallOmarchyIntegration, type OmarchyProfile } from '../../src/infra/runtime/omarchy-integration.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(): OmarchyProfile {
  const home = mkdtempSync(join(tmpdir(), 'memphis-omarchy-')); roots.push(home);
  const profile = { home, runtimeRoot: join(home, 'runtime with space'), dataRoot: join(home, 'memory'), envPath: join(home, 'runtime.env'), nodePath: process.execPath };
  mkdirSync(join(profile.runtimeRoot, 'bin'), { recursive: true });
  writeFileSync(join(profile.runtimeRoot, 'bin/memphis.js'), "console.log(JSON.stringify({ args: process.argv.slice(2), root: process.env.MEMPHIS_RUNTIME_ROOT, data: process.env.MEMPHIS_DATA_DIR, env: process.env.MEMPHIS_ENV_FILE }))");
  mkdirSync(join(home, '.config/omarchy/extensions'), { recursive: true });
  writeFileSync(join(home, '.config/omarchy/extensions/omarchy-menu.jsonc'), '{\n// Custom entry\n' + JSON.stringify('personal') + ': ' + JSON.stringify({ action: 'echo "hello,}"' }) + ',\n}\n');
  writeFileSync(join(home, '.bashrc'), '# user configuration\n');
  return profile;
}
it('installs twice, launches outside the checkout, upgrades and preserves unrelated edits on uninstall', () => {
  const profile = fixture();
  const first = planOmarchyIntegration(profile);
  expect(first.conflicts).toEqual([]);
  expect(existsSync(join(profile.home, '.local/bin/memphis'))).toBe(false);
  expect(applyOmarchyIntegration(first).changed.length).toBeGreaterThan(6);
  const next = planOmarchyIntegration(profile);
  expect(next.files.every((file) => file.action === 'unchanged')).toBe(true);
  expect(applyOmarchyIntegration(next).changed).toEqual([]);
  const launcher = join(profile.home, '.local/bin/memphis');
  const out = JSON.parse(execFileSync(launcher, ['tui', '--input=quote $() `x`'], { cwd: tmpdir(), encoding: 'utf8' }));
  expect(out).toEqual({ args: ['tui', '--input=quote $() `x`'], root: profile.runtimeRoot, data: profile.dataRoot, env: profile.envPath });
  const bashrc = join(profile.home, '.bashrc');
  writeFileSync(bashrc, readFileSync(bashrc, 'utf8') + '# later user change\n');
  const upgraded = { ...profile, dataRoot: join(profile.home, 'another-root') };
  expect(applyOmarchyIntegration(planOmarchyIntegration(upgraded)).changed).toContain(launcher);
  const result = uninstallOmarchyIntegration(profile.home);
  expect(result.preserved).toEqual([]);
  expect(existsSync(launcher)).toBe(false);
  expect(readFileSync(bashrc, 'utf8')).toBe('# user configuration\n# later user change\n');
  expect(readFileSync(join(profile.home, '.config/omarchy/extensions/omarchy-menu.jsonc'), 'utf8')).toContain('// Custom entry');
  expect(uninstallOmarchyIntegration(profile.home).removed).toEqual([]);
});
it('refuses foreign launchers and preserves edits made to an owned launcher', () => {
  const profile = fixture(); const launcher = join(profile.home, '.local/bin/memphis');
  mkdirSync(join(profile.home, '.local/bin'), { recursive: true });
  writeFileSync(launcher, '# custom');
  const conflict = planOmarchyIntegration(profile);
  expect(conflict.conflicts).toContain(launcher);
  expect(() => applyOmarchyIntegration(conflict)).toThrow(/conflicts/);
  expect(readFileSync(launcher, 'utf8')).toBe('# custom');
  rmSync(launcher);
  applyOmarchyIntegration(planOmarchyIntegration(profile));
  writeFileSync(launcher, '# changed after install');
  expect(uninstallOmarchyIntegration(profile.home).preserved).toContain(launcher);
  expect(readFileSync(launcher, 'utf8')).toBe('# changed after install');
});
it('rejects a symlink escaping user-owned integration paths', () => {
  const profile = fixture();
  mkdirSync(join(profile.home, '.local'), { recursive: true });
  symlinkSync('/usr/bin', join(profile.home, '.local/bin'));
  expect(() => planOmarchyIntegration(profile)).toThrow(/symlink/);
});
