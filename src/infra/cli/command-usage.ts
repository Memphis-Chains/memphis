/**
 * The usage line the operator reads, and the rule that keeps it honest.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * The line used to be a hand-written template literal inside the system
 * handler, while the list of commands the CLI actually dispatches lived in
 * `src/infra/cli/registry.ts`. Nothing compared the two, so the line fell
 * behind — which is the same failure shape as every other drift this repo
 * has been closing: two copies of one rule with no gate.
 *
 * Measured 2026-11-22 on this host: **fifteen of the forty-three
 * registered commands were not in the help at all** — `recovery`,
 * `kartograf`, `dream`, `auth`, `budget`, `tier`, `voice`, `schedule`,
 * `consent`, `tensor`, `provider`, `brave`, `identity`, `attachments`,
 * `tools`. A command the operator cannot find is a command the operator
 * does not have, and one of the missing ones (`recovery`) is exactly what
 * resolves the turns the runtime left unsettled.
 *
 * The registry says WHICH commands exist; this module says what each one
 * accepts. The gate is `tests/unit/cli-command-usage.test.ts`: every
 * registered command has to be named here, so the next one fails the gate
 * instead of vanishing from the help.
 *
 * The line is a `|`-separated list of GROUPS, and a group is separated
 * from the next by ' | ' (space, pipe, space) while the SUBCOMMANDS inside
 * one group are separated by a bare '|'. That distinction is what
 * `helpCommandStarters` reads.
 */

/**
 * The usage of every command, in the order the operator reads them.
 *
 * `providerOptions` is the list of provider names the registry declares —
 * it is interpolated into the models group, where it always was.
 */
export function buildCommandUsageLine(providerOptions: string): string {
  return `init [status] [--state minimal-baseline|guided-conversation] [--non-interactive] [--operator-passphrase <secret>] [--passphrase <secret>] [--recovery-question <q>] [--recovery-answer <a>] | setup telegram --bot-token <token> [--allowed-user-ids <csv>] | readiness [--json] | self-governance status [--json] | slo status [--days <n>] [--json] | deploy run|health|rollback [--profile local-service|build-only|custom] [--build-command <cmd>] [--deploy-command <cmd>] [--health-url <url>] [--test-suite ts|rust|lint|typecheck|all] [--latest <n>] [--deep] [--dry-run] | backup [create|list|verify <file>|restore <file>|clean [--dry-run]] [--yes] [--pepper-restore <old-pepper>] [--keep <n>] [--tag <name>] | budget list|reconcile <id> --tokens <n> | schedule list|add|remove|enable|disable|run|reconcile | self-update [check] | kill-zombies [--dry-run] [--port <n>] | status [--json] | identity init|recover|show | service status|install|logs|restart|uninstall [--latest <n>] | worker status|once|run [--duration-ms <n>] | reset --runtime --yes | repair runtime [--force] [--dry-run] [--operator-passphrase <secret>] | recovery list|show <id>|acknowledge <id>|acknowledge-legacy <id> | health [--cron] | reflect [--save] | learn [--reset] | insights [--daily|--weekly|--topic <name>] | dream list|show|propose|rekey|status|apply | kartograf sign|verify|install|activate|status|query | connections scan|find --query "A,B" | suggest | categorize <text> [--save] | knowledge status|sources|query --topic <text> [--source <id>] [--limit <n>] | attachments prune | providers health|list|credential-check|probe | provider list|add <provider> --api-key <key> | models list | chat|ask|ask-session|route|decide --input "..."|history|transition|infer [--days <n>] [--repo-path <path>] [chain-first default]|predict [--repo-path <path>] [chain-first default]|git-stats [--days <n>] [--repo-path <path>] [legacy debug only; git is not runtime memory]|agents list|agents discover|agents show <did>|relationships show <did>|trust list|add <tool>|remove <tool>|mode set <full|quiet|balanced|paranoid>|mcp [serve|serve-once|serve-status|serve-stop] [--input "..."] [--session <name>] [--schema] [--transport stdio|http] [--port <n>] [--duration-ms <n>] [--to proposed|accepted|implemented|verified|superseded|rejected] [--provider ${providerOptions}] [--model <id>] [--tui|--interactive] [--strategy default|latency-aware] | voice status | brave configure|status | consent mark | ascii [--size small|medium|large] | progress | celebrate <milestone> | guide | tui [--check-only --json] [--run-command "/config tools list" --json] | doctor [--fix [--apply] --force --deep --post-install] | config tools <list|allow|deny|set|check|reset|pending|approve-call|deny-call> | config surfaces <list|check|set|reset> | tier status|elevate | tools list|describe | chain import_json --file <path> [--write --confirm-write --out <path>] | chain export --chain <name> [--out <path>] | export --format=mv2 --output <file> [--include <chains>] | import --from-mv2 <file> --into <fresh-directory> [--trusted-signer <did>] (--dry-run|--write --confirm-write) | chain rebuild [--out <path>] | chain verify [--chain <name>] | search --query <phrase> [--top-k <n>] [--chain <name>] | search rebuild [--chain <name>] | sync status [--chain <name>]|push --chain <name>|pull --agent <did>|network | trade offer --recipient <did> [--blocks 1-100] [--file <path>] | trade accept --offer-id <id> --file <offer.json> | vault init|add|get|list|reset|pepper-rotate [--confirm] [--generate]|master-key-rotate|entry-delete|recovery-unlock|sync-env | audit search [--since <iso>] [--until <iso>] [--action <pattern>] [--status <pattern>] [--limit <n>] | audit-runtime [--json] | embed store|search [--tuned]|reindex [--chain <name>]|reset | tensor status | evolve status|rollback|log | apps list|show|plan|run|validate|import|install|start|stop|restart|status|doctor|dashboard | skills list|show|install|create|validate|import | operator status|set-passphrase|recover | telegram send|status | secret add|get|list | auth anthropic|audit | explain [--chain <name>] [--case-type <type>] [--entity <name>] | debug trace|profile|memory|monitor | completion <bash|zsh|fish>`;
}

/**
 * The command names the usage line names.
 *
 * A group starter is a command the operator can type on its own; the
 * names after a bare '|' inside a group are its subcommands. The gate
 * asks whether every registered command appears among the starters.
 */
export function helpCommandStarters(usage: string): Set<string> {
  const starters = new Set<string>();
  for (const group of usage.split(' | ')) {
    for (const part of group.split('|')) {
      const token = part.trim().split(/[\s[]/)[0];
      if (token) starters.add(token);
    }
  }
  return starters;
}
