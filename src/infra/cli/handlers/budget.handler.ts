import type { CommandHandler } from './command-handler.js';
import { promptOperatorPassphrase } from './recovery.handler.js';
import { budgetDatabasePath, listPendingBudgetReservations, providerBudgetLedgerSnapshot, reconcileBudgetReservation } from '../../runtime/provider-budget-ledger.js';

export const budgetCommandHandler: CommandHandler = {
  name: 'budget', commands: ['budget'], canHandle: (context) => context.args.command === 'budget',
  async handle(context) {
    const action = context.args.subcommand ?? 'list';
    const config = context.getConfig();
    const env = { ...process.env, DATABASE_URL: config.DATABASE_URL };
    const path = budgetDatabasePath(env);
    if (action === 'list') {
      const snapshot = providerBudgetLedgerSnapshot(path, env);
      console.log(JSON.stringify({ ...snapshot, reservations: snapshot.available ? listPendingBudgetReservations(path) : [] }, null, 2));
      return true;
    }
    if (action !== 'reconcile') throw new Error('use budget list or budget reconcile <id> --tokens <confirmed-token-count>');
    const index = context.argv.indexOf('reconcile');
    const id = context.argv[index + 1];
    const tokenIndex = context.argv.indexOf('--tokens');
    const raw = tokenIndex >= 0 ? context.argv[tokenIndex + 1] : undefined;
    if (!id || !raw || !/^[0-9]+$/.test(raw)) throw new Error('reconcile requires an id and --tokens <confirmed-token-count>');
    const force = context.argv.includes('--force-running');
    if (force) process.stderr.write('Warning: verify the request is no longer running before forcing reconciliation.\n');
    const passphrase = await promptOperatorPassphrase();
    reconcileBudgetReservation(path, id, Number(raw), passphrase, force);
    console.log(`Recorded operator-reviewed usage for ${id}; verify provider billing separately.`);
    return true;
  },
};
