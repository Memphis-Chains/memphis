import { resolveAgentProfile } from './agent-profile.js';
import { listEnabledFeatureFlags } from './features/flags.js';
import { resolveSurfacePolicy } from '../gateway/surface-policy.js';
import { createInProcessToolExecutor } from '../gateway/tool-executor.js';
import { listInstalledSkillSummaries } from '../modules/skills/runtime.js';

export interface OperatorGuideSection {
  title: string;
  lines: string[];
}

export interface OperatorGuide {
  agentName: string;
  ownerName: string;
  profileSource: 'profile' | 'env' | 'default';
  sections: OperatorGuideSection[];
}

export type OperatorGuideSurface = 'tui' | 'telegram';

function hasValue(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

function statusLabel(value: boolean, ok = 'configured', bad = 'missing'): string {
  return value ? ok : bad;
}

export function buildOperatorGuide(rawEnv: NodeJS.ProcessEnv = process.env): OperatorGuide {
  const tools = createInProcessToolExecutor({ rawEnv })
    .listTools()
    .map((tool) => tool.name)
    .sort();
  const enabledFeatures = listEnabledFeatureFlags(rawEnv);
  const installedSkills = listInstalledSkillSummaries(rawEnv);

  const resolvedProfile = resolveAgentProfile(rawEnv);
  const { agentName, ownerName } = resolvedProfile.profile;
  const rustEnabled = (rawEnv.RUST_CHAIN_ENABLED ?? '').toLowerCase() === 'true';
  const embedPersist = (rawEnv.RUST_EMBED_PERSIST_ENABLED ?? '').toLowerCase() === 'true';
  const telegramBaselinePolicy = resolveSurfacePolicy('telegram', {} as NodeJS.ProcessEnv);
  const telegramPolicy = resolveSurfacePolicy('telegram', rawEnv);
  const telegramBaselineMode = `tier=${telegramBaselinePolicy.maxToolTier}, urlFetch=${telegramBaselinePolicy.allowUrlFetch ? 'enabled' : 'disabled'}, unknownTools=${telegramBaselinePolicy.allowUnknownTools ? 'allowed' : 'blocked'}, operatorOverride=${telegramBaselinePolicy.allowOperatorOverride ? 'allowed' : 'blocked'}`;
  const telegramEffectiveMode = `tier=${telegramPolicy.maxToolTier}, urlFetch=${telegramPolicy.allowUrlFetch ? 'enabled' : 'disabled'}, unknownTools=${telegramPolicy.allowUnknownTools ? 'allowed' : 'blocked'}, operatorOverride=${telegramPolicy.allowOperatorOverride ? 'allowed' : 'blocked'}`;

  return {
    agentName,
    ownerName,
    profileSource: resolvedProfile.source,
    sections: [
      {
        title: 'Identity',
        lines: [
          `Agent name: ${agentName}`,
          `Owner name: ${ownerName}`,
          `Identity source: ${resolvedProfile.source} (${resolvedProfile.path})`,
          'The gateway prompt teaches the agent its runtime model, tools, memory, vault, and Rust core constraints.',
        ],
      },
      {
        title: 'Bootstrap',
        lines: [
          'Canonical local flow for the full solo-local runtime:',
          '1. npm run bootstrap',
          '2. npm run -s cli -- init',
          '3. npm run -s cli -- health --json',
          '4. Bootstrap installs and enables a systemd user service when available; otherwise start with npm run dev',
          '5. npm run -s cli -- tui',
          'Release distribution is package-first: GitHub Releases attach one npm tarball asset and GitHub Packages publishes @memphis-chains/memphis.',
          'Optional channel gateway: set MEMPHIS_CHANNEL_GATEWAY_ENABLED=true and a Telegram token to enable the Telegram bot bridge.',
          'Optional Matrix pilot: run npm run -s cli -- setup matrix after init. Memphis stores pilot credentials in vault and only becomes pilot-ready once a real Matrix access token is available.',
        ],
      },
      {
        title: 'Secrets',
        lines: [
          `MEMPHIS_API_TOKEN: ${statusLabel(hasValue(rawEnv.MEMPHIS_API_TOKEN))}. Protects authenticated HTTP routes.`,
          `MEMPHIS_VAULT_PEPPER: ${statusLabel(hasValue(rawEnv.MEMPHIS_VAULT_PEPPER))}. Stable local secret used by the vault bridge; changing it breaks access to existing vault data.`,
          `Channel gateway: ${statusLabel((rawEnv.MEMPHIS_CHANNEL_GATEWAY_ENABLED ?? '').toLowerCase() === 'true', 'enabled', 'disabled by default')}. Optional Telegram bot transport.`,
        ],
      },
      {
        title: 'Memory',
        lines: [
          `Rust bridge: ${statusLabel(rustEnabled, 'enabled', 'disabled')}`,
          `Embed persistence: ${statusLabel(embedPersist, 'enabled', 'disabled')} (${rawEnv.RUST_EMBED_PERSIST_PATH?.trim() || '~/.memphis/embed/index-v1.json'})`,
          'HTTP memory routes: POST /api/journal, POST /api/recall, and POST /api/search',
          'TUI /embed store writes chain-backed operator memory and indexes it for recall.',
          'Exact search is FTS5-backed for "where is X mentioned?"; semantic recall stays embedding-backed for "what do I know about X?"',
          'TUI commands: /embed store <id> <value>, /embed search <query> [topK], /vault init|add|get|list',
          'Knowledge seam: memphis knowledge status|sources|query --topic "<text>" exposes curated repo and workspace truth without going through an LLM.',
        ],
      },
      {
        title: 'Tools',
        lines: [
          `In-process tools: ${tools.join(', ')}`,
          `Feature flags: ${enabledFeatures.length > 0 ? enabledFeatures.join(', ') : 'stable surface only'}`,
          'memphis_exec gives the agent shell access; memphis_recall, memphis_search, and memphis_journal are the memory loop.',
          'Surface hardening: use "memphis config surfaces list" to inspect Telegram/HTTP/CLI capability tiers and "memphis config surfaces set <surface> <setting> --value <...>" for explicit overrides.',
        ],
      },
      {
        title: 'Skills',
        lines: [
          `Installed skills: ${installedSkills.length > 0 ? installedSkills.map((skill) => skill.id).join(', ') : 'none installed'}`,
          'Skill marketplace: use "memphis skills list" to inspect the built-in and local catalog, "memphis skills install <id>" to materialize a skill into the runtime, and "memphis skills show <id>" to inspect its declared workflow.',
          'Creator flow: use "memphis skills create <id> --name <name>" to scaffold a new skill package with manifest.json + SKILL.md before importing or publishing it.',
        ],
      },
      {
        title: 'Surfaces',
        lines: [
          'Rust TUI is the authoritative operator cockpit: native chat, memory, sessions, vault, cases, and system state run through memphis-operator.',
          'TS-owned operator controls in the Rust TUI stay host-backed over the long-lived stdio JSON bridge instead of falling back to one-shot CLI calls.',
          'Telegram is a companion gateway surface, not the primary operator console. Replies go through the TypeScript channel adapter; the Rust TUI only shows readiness and host-routed sends.',
          `Telegram baseline companion policy: ${telegramBaselineMode}.`,
          `Telegram effective policy in this runtime: ${telegramEffectiveMode}.`,
          'Use "memphis guide", Rust TUI /guide, or Telegram /guide to inspect this runtime design from the active surface.',
        ],
      },
      {
        title: 'Recent capabilities',
        lines: [
          'Cross-surface presence: /status on any surface lists every active TUI/Telegram/HTTP session and when it last acted.',
          'On-the-fly config: /config show|set|reload on Telegram, TUI, and HTTP — hot fields swap immediately, cold fields return 409 (restart required), secret fields require tier 3.',
          'MCP parity: memphis_presence, memphis_config_show, memphis_config_reload mirror the TUI host capabilities for any MCP-speaking client (Claude Code, etc.).',
          'Disaster recovery: memphis backup restore <file> --pepper-restore <old-pepper> rewrites the destination .env so cross-host vault recovery just works. Drill it with `npm run drill:backup-restore`.',
          'Voice: /voice on|off|status on Telegram. Daily TTS quota via MEMPHIS_TTS_DAILY_CHAT_LIMIT (default 100 utterances/chat/day; 0 disables). Quota notice fires once when reached.',
          'Alerts: MEMPHIS_ALERT_SLACK_WEBHOOK and MEMPHIS_ALERT_WEBHOOK_URL fan out alongside PagerDuty/OpsGenie. Grafana dashboard at docs/observability/grafana-memphis.json.',
          'Cognitive frames: mode A automatically captures recent turn frames into a 128-entry ring buffer (MEMPHIS_FRAME_BUFFER_SIZE) and feeds the trailing five into the next system prompt.',
          'Chain integrity: memphis chain verify catches tampering. MEMPHIS_CHAIN_GC_ENABLED + MEMPHIS_CHAIN_GC_KEEP_ARCHIVES prune old archives after rotation; MEMPHIS_CHAIN_SNAPSHOT_ON_ROTATION (default true) writes snapshot-<ts>.json safety nets.',
          'Release awareness: memphis self-update check polls GitHub; latestVersion appears on /v1/ops/status.',
          'Self-restart: tier-3 /restart on Telegram, system.restart in TUI, POST /v1/ops/restart, memphis_restart MCP tool, memphis restart CLI. Drains in-flight turns, audits, and exits so the supervisor brings the process back. See docs/self-restart.md.',
          'All of the above is consolidated in docs/operator-handbook.md.',
        ],
      },
    ],
  };
}

export function renderOperatorGuideLines(rawEnv: NodeJS.ProcessEnv = process.env): string[] {
  const guide = buildOperatorGuide(rawEnv);
  const lines: string[] = [];

  lines.push('Memphis operator guide');
  for (const section of guide.sections) {
    lines.push(`${section.title}:`);
    for (const line of section.lines) {
      lines.push(`  ${line}`);
    }
    lines.push('');
  }

  if (lines.at(-1) === '') {
    lines.pop();
  }

  return lines;
}

export function renderOperatorGuideText(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return renderOperatorGuideLines(rawEnv).join('\n');
}

export function buildSurfaceDesignGuide(
  surface: OperatorGuideSurface,
  rawEnv: NodeJS.ProcessEnv = process.env,
): OperatorGuideSection {
  const guide = buildOperatorGuide(rawEnv);
  const telegramBaselinePolicy = resolveSurfacePolicy('telegram', {} as NodeJS.ProcessEnv);
  const telegramPolicy = resolveSurfacePolicy('telegram', rawEnv);

  if (surface === 'telegram') {
    return {
      title: 'Telegram companion guide',
      lines: [
        `${guide.agentName} is operator-supervised. Telegram is a companion chat gateway, not the authoritative Rust operator cockpit.`,
        'Messages route through the TypeScript gateway transport. The Rust TUI owns native operator chat, vault, memory, sessions, and system inspection.',
        `Baseline Telegram policy: tier=${telegramBaselinePolicy.maxToolTier}; URL fetch ${telegramBaselinePolicy.allowUrlFetch ? 'enabled' : 'disabled'}; unknown tools ${telegramBaselinePolicy.allowUnknownTools ? 'allowed' : 'blocked'}; operator override ${telegramBaselinePolicy.allowOperatorOverride ? 'allowed' : 'blocked'}.`,
        `Effective Telegram policy in this runtime: tier=${telegramPolicy.maxToolTier}; URL fetch ${telegramPolicy.allowUrlFetch ? 'enabled' : 'disabled'}; unknown tools ${telegramPolicy.allowUnknownTools ? 'allowed' : 'blocked'}; operator override ${telegramPolicy.allowOperatorOverride ? 'allowed' : 'blocked'}.`,
        'Quick reference: /tier 0|1|2 (or /tier 3 <passphrase> for secrets), /status for runtime + cross-surface presence, /chains and /search for Rust-backed state, /mode A..E for cognitive mode.',
        '/config show|set|reload changes runtime config without a restart (tier 3 for secret fields).',
        '/voice on|off|status toggles TTS replies and shows the daily TTS quota (default 100 utterances/day).',
        'Use memphis tui or "memphis guide" when you need the full native operator design and cockpit workflow.',
        'See docs/operator-handbook.md for the day-by-day operator playbook.',
      ],
    };
  }

  return {
    title: 'Rust TUI guide',
    lines: [
      'The Rust TUI is the authoritative operator cockpit. Native chat runs through memphis-operator instead of the HTTP gateway.',
      'TS-owned controls remain host-backed over a persistent stdio JSON extension host. Unknown slash commands fail closed unless you intentionally use /legacy.',
      'Use /guide to review shared runtime design, /telegram for companion readiness, and /config surfaces list to inspect cross-surface capability policy.',
      'Recent host capabilities: presence.snapshot (Sprint 5), config.show / config.set / config.reload (Sprint 6), cognitive.mode get|set (Sprint 4), security.tier.elevate|status|revoke (Sprint 2).',
      'See docs/operator-handbook.md for the consolidated operator workflow.',
    ],
  };
}

export function renderSurfaceDesignGuideText(
  surface: OperatorGuideSurface,
  rawEnv: NodeJS.ProcessEnv = process.env,
): string {
  const section = buildSurfaceDesignGuide(surface, rawEnv);
  return [section.title, ...section.lines.map((line) => `- ${line}`)].join('\n');
}
