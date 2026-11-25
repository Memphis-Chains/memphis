import { isAbsolute, resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';

import { resolveInstallRoot } from '../../runtime/install-root.js';
import { acknowledgeLegacyOperation, acknowledgeRecoveryTurn, listLegacyOperations, listRecoveryTurns, showRecoveryPartial } from '../../runtime/turn-recovery.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';

/** Deliberately requires a fresh local TTY, never an environment or CLI secret. */
export async function promptOperatorPassphrase(label = 'Operator passphrase: '): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !input.setRawMode) throw new Error('recovery acknowledgement requires a local interactive terminal');
  return new Promise((resolvePromise, reject) => {
    let value = '';
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    process.stderr.write(label);
    const done = (error?: Error): void => {
      input.off('keypress', keypress);
      input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
      if (error) reject(error); else resolvePromise(value);
    };
    const keypress = (char: string | undefined, key: { ctrl?: boolean; meta?: boolean; name?: string }): void => {
      if (key.ctrl && key.name === 'c') { done(new Error('cancelled')); return; }
      if (key.name === 'return' || key.name === 'enter') { done(); return; }
      if (key.name === 'backspace') { value = Array.from(value).slice(0, -1).join(''); return; }
      // eslint-disable-next-line no-control-regex -- reject terminal control characters from password input
      if (char && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/u.test(char)) value += char;
    };
    input.on('keypress', keypress);
  });
}

function databasePath(context: CliContext): string {
  const url = context.getConfig().DATABASE_URL;
  if (!url.startsWith('file:')) throw new Error('recovery requires a file: SQLite database');
  const file = url.slice(5);
  return isAbsolute(file) ? file : resolve(resolveInstallRoot(), file);
}

export const recoveryCommandHandler: CommandHandler = {
  name: 'recovery',
  commands: ['recovery'],
  canHandle: (context) => context.args.command === 'recovery',
  async handle(context) {
    const action = context.args.subcommand ?? 'list';
    const path = databasePath(context);
    if (action === 'list') {
      const turns = listRecoveryTurns(path);
      const legacyOperations = listLegacyOperations(path);
      // The turns that need a decision come first, and the summary says
      // how many there are.
      //
      // Measured on this host before the fix: the list showed 46 turns,
      // of which 31 had NOTHING outstanding — a turn that failed without
      // dispatching a tool cannot have left a half-applied side effect.
      // The Rust console (the authoritative operator cockpit) armed its
      // recovery guard on the narrow definition and showed 15. Two
      // surfaces, two definitions of the same thing — the operator could
      // not tell which list was telling the truth.
      //
      // The narrow definition is the one the guard uses, and it is the one
      // the console now shows first.
      const ordered = [...turns].sort((a, b) => {
        if (a.needsAcknowledgement !== b.needsAcknowledgement) return a.needsAcknowledgement ? -1 : 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
      const needsAcknowledgement = ordered.filter((turn) => turn.needsAcknowledgement).length;
      console.log(JSON.stringify({
        summary: {
          total: ordered.length,
          needsAcknowledgement,
          nothingOutstanding: ordered.length - needsAcknowledgement,
          legacyOperations: legacyOperations.length,
        },
        turns: ordered,
        legacyOperations,
      }, null, 2));
      return true;
    }
    if (action !== 'acknowledge' && action !== 'acknowledge-legacy' && action !== 'show') throw new Error('use recovery list, recovery show <turn-id>, recovery acknowledge <turn-id>, or recovery acknowledge-legacy <operation-id>');
    const index = context.argv.indexOf(action);
    const id = index >= 0 ? context.argv[index + 1] : undefined;
    if (!id || (action !== 'acknowledge-legacy' && !/^[0-9a-f]{32}$/.test(id))) throw new Error('recovery command requires a valid id');
    if (action === 'show') {
      console.log(JSON.stringify(showRecoveryPartial(path, id), null, 2));
      return true;
    }
    const force = context.argv.includes('--force-running');
    if (force) process.stderr.write('Warning: verify the original turn is no longer running before forcing acknowledgement.\n');
    const passphrase = await promptOperatorPassphrase();
    const authority = { kind: 'passphrase', passphrase } as const;
    if (action === 'acknowledge-legacy') acknowledgeLegacyOperation(path, id, authority, force);
    else acknowledgeRecoveryTurn(path, id, authority, force);
    console.log(`Acknowledged ${id}. This does not undo or prove the effects of prior operations.`);
    return true;
  },
};
