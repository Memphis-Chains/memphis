import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getDataDir } from '../../../config/paths.js';
import { resolveDotEnvPath } from '../../config/dotenv-file.js';
import { resolveInstallRoot } from '../../runtime/install-root.js';
import { applyOmarchyIntegration, planOmarchyIntegration, uninstallOmarchyIntegration } from '../../runtime/omarchy-integration.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

export async function handleOmarchyCommand(context: CliContext): Promise<boolean> {
  if (context.args.command !== 'omarchy') return false;
  const action = context.args.subcommand ?? 'plan';
  const home = homedir();
  if (['uninstall', 'rollback'].includes(action)) {
    print(uninstallOmarchyIntegration(home), context.args.json);
    return true;
  }
  const runtimeRoot = resolveInstallRoot();
  const plan = planOmarchyIntegration({ home, runtimeRoot, dataRoot: getDataDir(), envPath: resolveDotEnvPath(), nodePath: process.execPath });
  if (action === 'plan' || (action === 'install' && !context.args.apply)) {
    print({ profile: plan.profile, files: plan.files.map(({ path, action }) => ({ path, action })), conflicts: plan.conflicts, apply: 'memphis omarchy install --apply' }, context.args.json);
    return true;
  }
  if (action !== 'install') throw new Error('Usage: memphis omarchy plan|install --apply|uninstall|rollback');
  if (!existsSync('/usr/bin/omarchy') || !existsSync(join(home, '.config/hypr/hyprland.lua'))) throw new Error('This installer supports the Omarchy Lua desktop profile');
  if (Number(process.versions.node.split('.')[0]) < 22 || !existsSync(join(runtimeRoot, 'dist/infra/cli/index.js'))) throw new Error('Build Memphis with Node 22+ before installing integration');
  const result = applyOmarchyIntegration(plan);
  const verify = spawnSync('systemd-analyze', ['--user', 'verify', join(home, '.config/systemd/user/memphis.service')], { encoding: 'utf8' });
  if (verify.status !== 0) throw new Error('Service validation failed; integration rollback is available via memphis omarchy rollback');
  for (const args of [['reload'], ['configerrors']]) {
    const check = spawnSync('hyprctl', args, { encoding: 'utf8' });
    if (check.status !== 0 || (args[0] === 'configerrors' && check.stdout.trim())) throw new Error('Hyprland validation failed; inspect hyprctl configerrors and use memphis omarchy rollback');
  }
  print({ ...result, activation: 'systemctl --user daemon-reload && systemctl --user enable --now memphis.service', defaultAgent: 'omarchy default agent memphis', session: 'Log out and in to refresh UWSM PATH.' }, context.args.json);
  return true;
}
