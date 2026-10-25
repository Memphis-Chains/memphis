import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { writePrivateAtomicFile } from '../config/private-atomic-file.js';

export interface OmarchyProfile {
  home: string;
  runtimeRoot: string;
  dataRoot: string;
  envPath: string;
  nodePath: string;
}
type IntegrationFile = { path: string; content: string; mode: number; marker?: string };
type OwnedFile = IntegrationFile & { previous: string | null; previousMode: number; hash: string };
interface IntegrationManifest { version: 1; profile: OmarchyProfile; files: OwnedFile[] }
export interface IntegrationPlan {
  profile: OmarchyProfile;
  files: Array<IntegrationFile & { action: 'create' | 'update' | 'unchanged' | 'conflict' }>;
  conflicts: string[];
}
const marker = 'memphis-omarchy-v1';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const unit = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
const script = (body: string) => `#!/bin/bash\nset -euo pipefail\n# Managed by Memphis Omarchy integration v1.\n${body}\n`;
const manifestPath = (home: string) => join(home, '.local/state/memphis/omarchy-integration.json');

function readManifest(home: string, pending = false): IntegrationManifest | null {
  const path = manifestPath(home) + (pending ? '.pending' : '');
  assertUserPath(home, path);
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8')) as IntegrationManifest;
  if (value.version !== 1 || !Array.isArray(value.files)) throw new Error('Unsupported Omarchy integration manifest');
  for (const file of value.files) assertUserPath(home, file.path);
  return value;
}
function assertUserPath(home: string, path: string) {
  const rel = relative(home, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Integration path must be inside the operator home');
  for (let current = path; current !== home; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Integration path is a symlink: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
function currentContent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
function block(content: string, prefix: string): string {
  return `${prefix} BEGIN ${marker}\n${content.trimEnd()}\n${prefix} END ${marker}\n`;
}
function blockRange(content: string, prefix: string): [number, number] | null {
  const begin = `${prefix} BEGIN ${marker}\n`;
  const end = `${prefix} END ${marker}\n`;
  const start = content.indexOf(begin);
  if (start < 0) return null;
  const stop = content.indexOf(end, start);
  if (stop < 0 || content.indexOf(begin, start + begin.length) >= 0) throw new Error('Malformed Memphis integration block');
  return [start, stop + end.length];
}
function replaceBlock(original: string, content: string, prefix: string): string {
  const range = blockRange(original, prefix);
  if (range) return original.slice(0, range[0]) + content + original.slice(range[1]);
  // Shell PATH must precede the usual noninteractive-shell early return.
  return prefix === '--' ? original + content : content + original;
}
function jsonc(content: string): Record<string, unknown> {
  const cleaned = content.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (token) => token.startsWith('"') ? token : token.replace(/[^\n]/g, ' '))
    .replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, (token) => token.startsWith('"') ? token : '');
  const parsed: unknown = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Omarchy menu must be a JSONC object');
  return parsed as Record<string, unknown>;
}

/** Pure plan: never changes a package file, runtime credentials or the default agent. */
export function planOmarchyIntegration(profile: OmarchyProfile): IntegrationPlan {
  if (existsSync(manifestPath(profile.home) + '.pending')) throw new Error('Interrupted Omarchy installation; run omarchy rollback first');
  for (const value of Object.values(profile)) {
    if (!isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('Omarchy profile requires absolute, single-line paths');
  }
  const { home, runtimeRoot, dataRoot, envPath, nodePath } = profile;
  const launcher = join(home, '.local/bin/memphis');
  const shim = join(home, '.local/share/omarchy-agent-shim');
  const defaultAgent = join(home, '.config/omarchy/defaults/agent');
  const pathExport = `export PATH=${shell(shim + ':' + join(home, '.local/bin'))}:"$PATH"`;
  const files: IntegrationFile[] = [];
  const full = (path: string, content: string, mode = 0o644) => files.push({ path: join(home, path), content, mode });
  const shared = (path: string, content: string, prefix: string) => {
    const absolute = join(home, path);
    assertUserPath(home, absolute);
    files.push({ path: absolute, content: replaceBlock(currentContent(absolute) ?? '', block(content, prefix), prefix), mode: 0o644, marker: prefix });
  };
  full('.local/bin/memphis', script(`export MEMPHIS_RUNTIME_ROOT=${shell(runtimeRoot)}\nexport MEMPHIS_ENV_FILE=${shell(envPath)}\nexport MEMPHIS_DATA_DIR=${shell(dataRoot)}\nexec ${shell(nodePath)} ${shell(join(runtimeRoot, 'bin/memphis.js'))} "$@"`), 0o755);
  full('.local/share/omarchy-agent-shim/omarchy', script(`${pathExport}\nif [[ \${1:-} == agent ]]; then\n  case "\${2:-}" in ''|--inline|--pick|--prompt) shift; exec ${shell(join(shim, 'omarchy-agent'))} "$@" ;; esac\nfi\nif [[ \${1:-} == default && \${2:-} == agent && \${3:-} == memphis ]]; then\n  shift 2; exec ${shell(join(shim, 'omarchy-default-agent'))} "$@"\nfi\nexec /usr/bin/omarchy "$@"`), 0o755);
  full('.local/share/omarchy-agent-shim/omarchy-agent', script(`agent=''\n[[ ! -f ${shell(defaultAgent)} ]] || agent=$(cat ${shell(defaultAgent)})\n[[ $agent == memphis ]] || exec /usr/bin/omarchy-agent "$@"\ninline=false\ncommand=(${shell(launcher)} tui)\nwhile (($#)); do\n  case "$1" in\n    --inline) inline=true; shift ;;\n    --pick) shift ;;\n    --prompt) command+=("--input=\${2:?--prompt needs a value}"); shift 2 ;;\n    *) echo 'Unsupported Memphis agent argument' >&2; exit 2 ;;\n  esac\ndone\n[[ $PWD != ${shell(home)} || ! -d ${shell(join(home, 'Work'))} ]] || cd ${shell(join(home, 'Work'))}\n[[ $inline != true ]] || exec "\${command[@]}"\nexec /usr/bin/omarchy-launch-tui --app-id=org.omarchy.agent "\${command[@]}"`), 0o755);
  full('.local/share/omarchy-agent-shim/omarchy-default-agent', script(`if [[ \${1:-} == memphis && $# == 1 ]]; then\n  mkdir -p ${shell(dirname(defaultAgent))}\n  printf '%s\\n' memphis >${shell(defaultAgent)}\n  exec ${shell(join(shim, 'omarchy-agent'))}\nfi\nexec /usr/bin/omarchy-default-agent "$@"`), 0o755);
  full('.local/share/applications/org.memphis.Memphis.desktop', `[Desktop Entry]\nType=Application\nName=Memphis\nComment=Memphis operator console\nExec=/usr/bin/omarchy-launch-tui --app-id=org.omarchy.agent ${unit(launcher)} tui\nIcon=utilities-terminal\nTerminal=false\nCategories=Development;\n`);
  full('.config/uwsm/env.d/50-memphis-agent.conf', `${pathExport}\n`);
  shared('.bashrc', pathExport, '#');
  shared('.bash_profile', pathExport, '#');
  shared('.config/hypr/bindings.lua', `-- Preserve the standard Agent binding; route it through the user adapter.\nlocal memphis_shim = ${JSON.stringify(join(shim, 'omarchy-agent'))}\nif o.cmd_present(memphis_shim) then\n  hl.unbind("SUPER + SHIFT + CTRL + A")\n  o.bind("SUPER + SHIFT + CTRL + A", "Agent", memphis_shim .. " --pick")\nend\nhl.env("PATH", ${JSON.stringify(shim + ':' + join(home, '.local/bin') + ':')} .. (os.getenv("PATH") or "/usr/bin"))`, '--');
  const menuPath = join(home, '.config/omarchy/extensions/omarchy-menu.jsonc');
  assertUserPath(home, menuPath);
  let menu = currentContent(menuPath) ?? '{}\n';
  const range = blockRange(menu, '//');
  if (range) menu = menu.slice(0, range[0]) + menu.slice(range[1]);
  const menuEntries = {
    'memphis': { label: 'Memphis', action: `${shell('/usr/bin/omarchy-launch-tui')} ${shell(launcher)} tui` },
    'setup.default.agent.memphis': { label: 'Memphis', action: `${shell(join(shim, 'omarchy-default-agent'))} memphis` },
  };
  const existingMenu = jsonc(menu);
  const menuConflict = Object.keys(menuEntries).some((key) => key in existingMenu);
  const insertion = menu.indexOf('{') + 1;
  const menuBlock = block(Object.entries(menuEntries).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)},`).join('\n'), '//');
  files.push({ path: menuPath, content: menu.slice(0, insertion) + menuBlock + menu.slice(insertion), mode: 0o644, marker: '//' });

  const service = join(home, '.config/systemd/user/memphis.service');
  const prior = readManifest(home);
  if (!existsSync(service) || prior?.files.some((file) => file.path === service)) {
    full('.config/systemd/user/memphis.service', '[Unit]\nDescription=Memphis local runtime\nStartLimitIntervalSec=300\nStartLimitBurst=5\n[Service]\nType=simple\nRestart=on-failure\nRestartSec=5\nRestartPreventExitStatus=101 102 103\n[Install]\nWantedBy=default.target\n');
  }
  full('.config/systemd/user/memphis.service.d/20-omarchy-profile.conf', `[Service]\nWorkingDirectory=${unit(runtimeRoot)}\nExecStart=\nExecStart=${unit(nodePath)} ${unit(join(runtimeRoot, 'dist/infra/cli/index.js'))} serve\nEnvironmentFile=${unit(envPath)}\nEnvironment=${unit('MEMPHIS_RUNTIME_ROOT=' + runtimeRoot)}\nEnvironment=${unit('MEMPHIS_ENV_FILE=' + envPath)}\nEnvironment=${unit('MEMPHIS_DATA_DIR=' + dataRoot)}\nEnvironment=${unit('MEMPHIS_HOST=127.0.0.1')}\nEnvironment=${unit('PATH=' + dirname(nodePath) + ':/usr/local/bin:/usr/bin')}\nUMask=0077\n`);
  const planned = files.map((file) => {
    assertUserPath(home, file.path);
    const current = currentContent(file.path);
    const owned = prior?.files.find((entry) => entry.path === file.path);
    let conflict = current !== null && current !== file.content && !file.marker && (!owned || hash(current) !== owned.hash);
    if (file.marker && current !== null) {
      const currentRange = blockRange(current, file.marker);
      const ownedRange = owned && blockRange(owned.content, file.marker);
      if (currentRange && (!ownedRange || current.slice(...currentRange) !== owned!.content.slice(...ownedRange))) conflict = true;
    }
    if (file.path === menuPath && menuConflict) conflict = true;
    return { ...file, action: conflict ? 'conflict' as const : current === file.content ? 'unchanged' as const : current === null ? 'create' as const : 'update' as const };
  });
  return { profile, files: planned, conflicts: planned.filter((file) => file.action === 'conflict').map((file) => file.path) };
}

export function applyOmarchyIntegration(plan: IntegrationPlan): { changed: string[]; manifest: string } {
  // Replan to detect edits since a displayed preview. Never overwrite a newly
  // changed user file using stale expected content.
  const fresh = planOmarchyIntegration(plan.profile);
  if (fresh.conflicts.length) throw new Error(`Preserve existing overrides; conflicts: ${fresh.conflicts.join(', ')}`);
  if (JSON.stringify(fresh.files) !== JSON.stringify(plan.files)) throw new Error('Omarchy configuration changed; refresh the preview');
  const previous = readManifest(plan.profile.home);
  const files = fresh.files.map((file): OwnedFile => {
    const owned = previous?.files.find((entry) => entry.path === file.path);
    return { ...file, previous: owned ? owned.previous : currentContent(file.path), previousMode: owned?.previousMode ?? (existsSync(file.path) ? lstatSync(file.path).mode & 0o777 : file.mode), hash: hash(file.content) };
  });
  const manifest: IntegrationManifest = { version: 1, profile: plan.profile, files };
  const path = manifestPath(plan.profile.home);
  assertUserPath(plan.profile.home, path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Persist rollback evidence before changing user integration files.
  writePrivateAtomicFile(path + '.pending', JSON.stringify(manifest));
  const changed: string[] = [];
  for (const file of files) {
    if (currentContent(file.path) === file.content) continue;
    mkdirSync(dirname(file.path), { recursive: true });
    writePrivateAtomicFile(file.path, file.content); chmodSync(file.path, file.mode); changed.push(file.path);
  }
  writePrivateAtomicFile(path, JSON.stringify(manifest, null, 2));
  unlinkSync(path + '.pending');
  return { changed, manifest: path };
}

/** Remove only owned bytes. User edits outside marked blocks survive removal. */
export function uninstallOmarchyIntegration(home: string): { removed: string[]; preserved: string[] } {
  const path = manifestPath(home);
  const pending = existsSync(path + '.pending');
  const manifest = readManifest(home, pending);
  if (!manifest) return { removed: [], preserved: [] };
  const removed: string[] = []; const preserved: string[] = [];
  for (const file of manifest.files) {
    assertUserPath(home, file.path);
    const current = currentContent(file.path);
    if (current === null) continue;
    if (pending && current === file.previous) continue;
    if (file.marker) {
      const range = blockRange(current, file.marker); const expected = blockRange(file.content, file.marker);
      if (!range || !expected || current.slice(...range) !== file.content.slice(...expected)) { preserved.push(file.path); continue; }
      const remaining = current.slice(0, range[0]) + current.slice(range[1]);
      writePrivateAtomicFile(file.path, remaining); chmodSync(file.path, file.previousMode);
    } else if (hash(current) !== file.hash) { preserved.push(file.path); continue; }
    else if (file.previous !== null) { writePrivateAtomicFile(file.path, file.previous); chmodSync(file.path, file.previousMode); }
    else unlinkSync(file.path);
    removed.push(file.path);
  }
  // Keep recovery evidence when an owned file was edited after installation.
  if (!preserved.length) {
    if (existsSync(path)) unlinkSync(path);
    if (pending) unlinkSync(path + '.pending');
  }
  return { removed, preserved };
}
