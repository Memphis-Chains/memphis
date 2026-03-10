import chalk from 'chalk';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AskOrchestrator } from '../providers/ask-orchestrator.js';
import { ContextWindowManager } from '../providers/context-window.js';
import { ConversationHistory } from '../providers/conversation-history.js';

export interface AskSessionConfig {
  provider: string;
  model: string;
  strategy: 'default' | 'latency-aware';
  maxTokens: number;
  contextWindow: number;
  temperature: number;
  systemPrompt?: string;
  persistencePath?: string;
}

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  tokenCount: number;
}

export class AskSession {
  private orchestrator: AskOrchestrator;
  private readonly contextManager: ContextWindowManager;
  private readonly history: ConversationHistory;
  private turnCount = 0;

  constructor(private readonly config: AskSessionConfig) {
    this.orchestrator = new AskOrchestrator({
      provider: config.provider,
      model: config.model,
      strategy: config.strategy,
    });
    this.contextManager = new ContextWindowManager(config.contextWindow);
    this.history = new ConversationHistory(config.persistencePath);
  }

  async start(): Promise<void> {
    console.log(chalk.cyan('🤖 Multi-turn Ask Session'));
    console.log(chalk.gray(`Provider: ${this.config.provider}`));
    console.log(chalk.gray(`Model: ${this.config.model}`));
    console.log(chalk.gray(`Context Window: ${this.config.contextWindow} tokens`));
    console.log(chalk.gray('Commands: /exit, /clear, /history, /stats, /switch <provider> <model>'));
    console.log('');

    if (this.config.systemPrompt) {
      this.history.addTurn('system', this.config.systemPrompt);
    }

    const rl = createInterface({ input, output });
    try {
      while (true) {
        const line = await rl.question(chalk.green('You: '));
        const trimmed = line.trim();

        if (trimmed.startsWith('/')) {
          const shouldExit = await this.handleCommand(trimmed);
          if (shouldExit) break;
          continue;
        }

        if (trimmed.length > 0) {
          await this.processUserInput(trimmed);
        }
      }
    } finally {
      rl.close();
    }
  }

  private async processUserInput(inputText: string): Promise<void> {
    this.turnCount += 1;
    this.history.addTurn('user', inputText);

    const context = this.contextManager.buildContext(this.history.getTurns());

    try {
      const response = await this.orchestrator.askWithContext(inputText, context, {
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
      });

      this.history.addTurn('assistant', response.content);
      const responseTokens = this.estimateTokens(response.content);
      console.log(chalk.blue('Assistant:'), response.content);
      console.log(chalk.gray(`  [${response.provider}/${response.model} | ${response.latency}ms | ${responseTokens} tokens]`));
      console.log('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Error:'), message);
    }
  }

  private async handleCommand(command: string): Promise<boolean> {
    const parts = command.split(' ');
    const cmd = parts[0]?.toLowerCase();

    switch (cmd) {
      case '/exit':
        console.log(chalk.yellow('Goodbye!'));
        return true;

      case '/clear':
        this.history.clear();
        this.contextManager.reset();
        this.turnCount = 0;
        console.log(chalk.green('✓ Conversation cleared'));
        return false;

      case '/history': {
        const turns = this.history.getTurns();
        console.log(chalk.cyan('Conversation History:'));
        for (const turn of turns) {
          const role =
            turn.role === 'user' ? chalk.green('You') : turn.role === 'assistant' ? chalk.blue('Assistant') : chalk.gray('System');
          const suffix = turn.content.length > 100 ? '...' : '';
          console.log(`${role}: ${turn.content.substring(0, 100)}${suffix}`);
        }
        console.log('');
        return false;
      }

      case '/stats': {
        const stats = this.getSessionStats();
        console.log(chalk.cyan('Session Stats:'));
        console.log(`  Turns: ${stats.turns}`);
        console.log(`  Total Tokens: ${stats.totalTokens}`);
        console.log(`  Context Usage: ${stats.contextUsage}%`);
        console.log(`  Provider: ${stats.provider}/${stats.model}`);
        console.log('');
        return false;
      }

      case '/switch':
        if (parts.length >= 3) {
          this.config.provider = parts[1] ?? this.config.provider;
          this.config.model = parts[2] ?? this.config.model;
          this.orchestrator = new AskOrchestrator({
            provider: this.config.provider,
            model: this.config.model,
            strategy: this.config.strategy,
          });
          console.log(chalk.green(`✓ Switched to ${this.config.provider}/${this.config.model}`));
        } else {
          console.log(chalk.red('Usage: /switch <provider> <model>'));
        }
        return false;

      default:
        console.log(chalk.red(`Unknown command: ${cmd}`));
        return false;
    }
  }

  private getSessionStats(): {
    turns: number;
    totalTokens: number;
    contextUsage: number;
    provider: string;
    model: string;
  } {
    const turns = this.history.getTurns();
    const totalTokens = turns.reduce((sum, turn) => sum + turn.tokenCount, 0);
    return {
      turns: turns.length,
      totalTokens,
      contextUsage: Math.round((totalTokens / this.config.contextWindow) * 100),
      provider: this.config.provider,
      model: this.config.model,
    };
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
