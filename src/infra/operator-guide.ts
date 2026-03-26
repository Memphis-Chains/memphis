import { resolveAgentProfile } from './agent-profile.js';
import { createInProcessToolExecutor } from '../gateway/tool-executor.js';

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

function hasValue(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

function statusLabel(value: boolean, ok = 'configured', bad = 'missing'): string {
  return value ? ok : bad;
}

export function buildOperatorGuide(rawEnv: NodeJS.ProcessEnv = process.env): OperatorGuide {
  const tools = createInProcessToolExecutor()
    .listTools()
    .map((tool) => tool.name)
    .sort();

  const resolvedProfile = resolveAgentProfile(rawEnv);
  const { agentName, ownerName } = resolvedProfile.profile;
  const rustEnabled = (rawEnv.RUST_CHAIN_ENABLED ?? '').toLowerCase() === 'true';
  const embedPersist = (rawEnv.RUST_EMBED_PERSIST_ENABLED ?? '').toLowerCase() === 'true';

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
          "2. npm run -s cli -- vault init --passphrase '<pass>' --recovery-question '<question>' --recovery-answer '<answer>'",
          '3. Bootstrap installs and enables a systemd user service when available; otherwise start with npm run dev',
          '4. npm run -s cli -- tui',
          'Release distribution is package-first: GitHub Releases attach one npm tarball asset and GitHub Packages publishes @memphis-chains/memphis.',
          'Optional channel gateway: set MEMPHIS_CHANNEL_GATEWAY_ENABLED=true and a Telegram token to enable the Telegram bot bridge.',
          'Optional Matrix pilot: run npm run -s cli -- setup matrix after vault init. Memphis stores pilot credentials in vault and only becomes pilot-ready once a real Matrix access token is available.',
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
          'HTTP memory routes: POST /api/journal and POST /api/recall',
          'TUI /embed store writes chain-backed operator memory and indexes it for recall.',
          'TUI commands: /embed store <id> <value>, /embed search <query> [topK], /vault init|add|get|list',
        ],
      },
      {
        title: 'Tools',
        lines: [
          `In-process tools: ${tools.join(', ')}`,
          'memphis_exec gives the agent shell access; memphis_recall and memphis_journal are the memory loop.',
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
