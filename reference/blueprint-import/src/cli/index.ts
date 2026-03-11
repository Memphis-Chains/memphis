#!/usr/bin/env node
/**
 * Memphis v4 — One App To Rule Them All
 *
 * Local-first cognitive agent with:
 * - Rust-powered memory chains (SOUL validated, SHA-256 linked)
 * - AES-256-GCM vault with Argon2id + 2FA
 * - Multi-chain wallet (Solana, Polkadot, NEAR)
 * - LLM provider system (Ollama, Minimax, OpenAI-compatible)
 * - Agent capabilities (exec, filesystem, app management)
 * - HTTP gateway for external integrations
 * - TUI dashboard (pi-tui Nexus)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  loadConfig,
  saveConfig,
  ensureDirectories,
  CHAINS_PATH,
  MEMPHIS_HOME,
} from '../config/index.js';
import {
  getSystemInfo,
  exec,
  isOllamaRunning,
  ollamaModels,
  pullOllamaModel,
  readFile,
  writeFile,
  listDir,
} from '../agent/system.js';
import { resolveProvider, defaultProviderConfig, type ChatMessage } from '../providers/index.js';
import { startGateway } from '../gateway/server.js';

const program = new Command();

program
  .name('memphis')
  .description('Local-first cognitive agent — one app to rule them all')
  .version('4.0.0');

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

program
  .command('init')
  .description('Initialize Memphis (chains + config + vault setup)')
  .action(async () => {
    console.log(chalk.cyan('\n  🧠 Memphis v4 — First Time Setup\n'));

    ensureDirectories();
    const config = loadConfig();

    // Check Ollama
    const ollamaOk = await isOllamaRunning();
    if (ollamaOk) {
      const models = await ollamaModels();
      console.log(chalk.green(`  ✓ Ollama running (${models.length} models)`));
      if (models.length === 0) {
        console.log(chalk.yellow('    Pulling default model...'));
        await pullOllamaModel('qwen2.5-coder:3b');
      }
    } else {
      console.log(
        chalk.yellow(
          '  ⚠ Ollama not running — install: curl -fsSL https://ollama.com/install.sh | sh',
        ),
      );
    }

    // Create genesis blocks via Rust core
    // TODO: Replace with napi bridge call when compiled
    console.log(chalk.green('  ✓ Chain directory ready'));

    saveConfig(config);
    console.log(chalk.green('  ✓ Config saved\n'));
    console.log(chalk.gray('  Next steps:'));
    console.log(chalk.gray('    memphis vault init          — create encrypted vault'));
    console.log(chalk.gray('    memphis journal "hello"      — first memory'));
    console.log(chalk.gray('    memphis ask "what can you do?" — talk to Memphis'));
    console.log(chalk.gray('    memphis tui                 — launch dashboard\n'));
  });

// ═══════════════════════════════════════════
// JOURNAL
// ═══════════════════════════════════════════

program
  .command('journal <message>')
  .description('Add a journal entry to memory')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .action(async (message: string, opts) => {
    const tags = opts.tags ? opts.tags.split(',').map((t: string) => t.trim()) : [];
    // TODO: napi bridge → chain_append(CHAINS_PATH, "journal", "journal", message, tags)
    console.log(chalk.green(`  ✓ journal — ${truncate(message, 60)}`));
    if (tags.length) console.log(chalk.gray(`    tags: ${tags.join(', ')}`));
  });

// ═══════════════════════════════════════════
// ASK (LLM + recall)
// ═══════════════════════════════════════════

program
  .command('ask <question>')
  .description('Ask Memphis (uses recall context + LLM)')
  .option('-m, --model <model>', 'Override model')
  .option('--no-recall', 'Skip memory recall')
  .action(async (question: string, opts) => {
    const config = loadConfig();
    const provider = await resolveProvider({ providers: config.providers });

    console.log(chalk.gray(`  🤔 ${question}\n`));

    // TODO: recall from chains via napi bridge
    // const context = chain_query(CHAINS_PATH, "*", question, null, 8);

    const soulPrompt = loadSoul();

    const messages: ChatMessage[] = [{ role: 'user', content: question }];

    try {
      const response = await provider.chat(messages, {
        model: opts.model,
        systemPrompt: soulPrompt || undefined,
      });

      console.log(chalk.white(`  ${response.content}\n`));
      console.log(chalk.gray(`  🤖 ${response.provider} (${response.model})`));
      if (response.tokens) {
        console.log(chalk.gray(`  💬 ${response.tokens.total} tokens`));
      }

      // TODO: save to ask chain via napi bridge
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
    }
  });

// ═══════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════

program
  .command('status')
  .description('Show Memphis status (hardcoded, no LLM)')
  .action(async () => {
    const sys = getSystemInfo();
    const config = loadConfig();

    console.log(chalk.cyan('\n  Memphis 🧠 v4.0.0\n'));

    // System
    console.log(chalk.white('  System:'));
    console.log(chalk.gray(`    Host: ${sys.hostname} (${sys.platform}/${sys.arch})`));
    console.log(chalk.gray(`    Memory: ${sys.freeMemMb}MB free / ${sys.totalMemMb}MB`));
    console.log(chalk.gray(`    Node: ${sys.nodeVersion}`));

    // Chains
    // TODO: napi bridge → chain_status(CHAINS_PATH)
    console.log(chalk.white('\n  Chains:'));
    console.log(chalk.gray('    (connect napi bridge for live data)'));

    // Providers
    console.log(chalk.white('\n  Providers:'));
    for (const p of config.providers) {
      const mark = p.apiKey || p.type === 'ollama' ? '✓' : '⚠';
      console.log(
        chalk.gray(`    ${mark} ${p.name} — ${p.model || 'default'} (priority: ${p.priority})`),
      );
    }

    // Ollama check
    const ollamaOk = await isOllamaRunning();
    console.log(chalk.gray(`\n  Ollama: ${ollamaOk ? '🟢 running' : '🔴 not running'}`));

    // Gateway
    if (config.gateway.enabled) {
      console.log(chalk.gray(`  Gateway: http://${config.gateway.host}:${config.gateway.port}`));
    }

    console.log();
  });

// ═══════════════════════════════════════════
// EXEC (agent command)
// ═══════════════════════════════════════════

program
  .command('exec <command>')
  .description('Execute a shell command via agent')
  .option('--cwd <dir>', 'Working directory')
  .option('--timeout <ms>', 'Timeout in milliseconds', '30000')
  .action(async (command: string, opts) => {
    const result = exec(command, {
      cwd: opts.cwd,
      timeout: parseInt(opts.timeout),
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(chalk.red(result.stderr));

    if (result.exitCode !== 0) {
      console.log(chalk.red(`\n  Exit: ${result.exitCode} (${result.durationMs}ms)`));
    }

    // TODO: log to ops chain via napi bridge
  });

// ═══════════════════════════════════════════
// FILE OPERATIONS
// ═══════════════════════════════════════════

program
  .command('read <path>')
  .description('Read a file')
  .action((filePath: string) => {
    try {
      console.log(readFile(filePath));
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
    }
  });

program
  .command('write <path> <content>')
  .description('Write content to a file')
  .action((filePath: string, content: string) => {
    try {
      writeFile(filePath, content);
      console.log(chalk.green(`  ✓ Written: ${filePath}`));
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
    }
  });

program
  .command('ls [path]')
  .description('List directory contents')
  .action((dirPath?: string) => {
    const files = listDir(dirPath || '.');
    for (const f of files) {
      const icon = f.isDirectory ? '📁' : '📄';
      const size = f.isDirectory ? '' : ` (${humanSize(f.size)})`;
      console.log(`  ${icon} ${f.path}${size}`);
    }
  });

// ═══════════════════════════════════════════
// PROVIDER MANAGEMENT
// ═══════════════════════════════════════════

program
  .command('provider <action> [name]')
  .description('Manage LLM providers (list, test, add, remove)')
  .option('--type <type>', 'Provider type: ollama, minimax, openai-compatible')
  .option('--url <url>', 'API base URL')
  .option('--key <key>', 'API key')
  .option('--model <model>', 'Default model')
  .action(async (action: string, name?: string, opts?: any) => {
    const config = loadConfig();

    switch (action) {
      case 'list':
        console.log(chalk.cyan('\n  🤖 LLM Providers\n'));
        for (const p of config.providers) {
          console.log(`  ${p.priority}. ${p.name} (${p.type}) — ${p.model || 'default'}`);
        }
        break;

      case 'test':
        console.log(chalk.gray('  Testing providers...\n'));
        for (const p of config.providers) {
          try {
            const { resolveProvider: rp } = await import('../providers/index.js');
            const provider = await rp({ providers: [p] });
            const avail = await provider.isAvailable();
            console.log(`  ${avail ? '✓' : '✗'} ${p.name}`);
          } catch (err: any) {
            console.log(`  ✗ ${p.name} — ${err.message}`);
          }
        }
        break;

      case 'add':
        if (!name) {
          console.log(chalk.red('  Name required'));
          return;
        }
        config.providers.push({
          name,
          type: opts?.type || 'openai-compatible',
          priority: config.providers.length + 1,
          url: opts?.url,
          apiKey: opts?.key,
          model: opts?.model,
        });
        saveConfig(config);
        console.log(chalk.green(`  ✓ Added: ${name}`));
        break;

      case 'remove':
        if (!name) {
          console.log(chalk.red('  Name required'));
          return;
        }
        config.providers = config.providers.filter((p) => p.name !== name);
        saveConfig(config);
        console.log(chalk.green(`  ✓ Removed: ${name}`));
        break;

      default:
        console.log(chalk.gray('  Usage: memphis provider list|test|add|remove'));
    }
    console.log();
  });

// ═══════════════════════════════════════════
// GATEWAY
// ═══════════════════════════════════════════

program
  .command('gateway [action]')
  .description('Start/stop Memphis HTTP gateway')
  .action(async (action?: string) => {
    const config = loadConfig();
    if (action === 'start' || !action) {
      await startGateway(
        {
          port: config.gateway.port,
          host: config.gateway.host,
          authToken: config.gateway.authToken,
        },
        CHAINS_PATH,
        MEMPHIS_HOME,
      );
    }
  });

// ═══════════════════════════════════════════
// DOCTOR
// ═══════════════════════════════════════════

program
  .command('doctor')
  .description('Health check — diagnose common issues')
  .action(async () => {
    console.log(chalk.cyan('\n  🏥 Memphis Doctor\n'));

    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

    // Node
    checks.push({ name: 'Node.js', ok: true, detail: process.version });

    // Config
    const { existsSync } = await import('node:fs');
    const configOk = existsSync(MEMPHIS_HOME + '/config.yaml');
    checks.push({ name: 'Config', ok: configOk, detail: configOk ? 'found' : 'run: memphis init' });

    // Chains dir
    const chainsOk = existsSync(CHAINS_PATH);
    checks.push({ name: 'Chains', ok: chainsOk, detail: chainsOk ? 'found' : 'run: memphis init' });

    // Ollama
    const ollamaOk = await isOllamaRunning();
    const models = ollamaOk ? await ollamaModels() : [];
    checks.push({
      name: 'Ollama',
      ok: ollamaOk,
      detail: ollamaOk ? `${models.length} models` : 'not running',
    });

    // Vault
    const vaultOk = existsSync(MEMPHIS_HOME + '/vault.json');
    checks.push({
      name: 'Vault',
      ok: vaultOk,
      detail: vaultOk ? 'initialized' : 'run: memphis vault init',
    });

    for (const c of checks) {
      const mark = c.ok ? chalk.green('✓') : chalk.yellow('⚠');
      console.log(`  ${mark} ${c.name}: ${c.detail}`);
    }

    const passed = checks.filter((c) => c.ok).length;
    console.log(`\n  ${passed}/${checks.length} checks passed\n`);
  });

// ═══════════════════════════════════════════
// VERIFY
// ═══════════════════════════════════════════

program
  .command('verify')
  .description('Verify all chain integrity (via Rust core)')
  .action(async () => {
    // TODO: napi bridge → chain_validate for each chain
    console.log(chalk.gray('  (connect napi bridge for Rust-powered verification)'));
  });

// ═══════════════════════════════════════════
// TUI
// ═══════════════════════════════════════════

program
  .command('tui')
  .description('Launch Terminal User Interface dashboard')
  .action(async () => {
    // TODO: import and launch pi-tui Nexus
    console.log(chalk.cyan('  🖥  Memphis Nexus TUI — coming in Phase 3'));
  });

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

function loadSoul(): string | null {
  try {
    const candidates = [`${MEMPHIS_HOME}/SOUL.md`, `${process.cwd()}/SOUL.md`];
    for (const p of candidates) {
      try {
        return readFile(p);
      } catch {}
    }
  } catch {}
  return null;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

program.parse();
