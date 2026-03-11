import { AskSession } from '../../../cli/ask-session.js';
import { runInteractiveTui } from '../interactive-tui.js';
import { runTuiApp } from '../../../tui/index.js';
import { print, printChat, printTuiAnswer } from '../utils/render.js';
import { runAskSessionInteractive, runAskSessionTurn } from '../utils/ask-session.js';
import type { CliContext } from '../context.js';

export async function handleInteractionCommand(context: CliContext): Promise<boolean> {
  const { args } = context;
  const { command, session, interactive, input, provider, model, strategy, json, tui, maxTokens, contextWindow, temperature, systemPrompt } = args;

  if (command === 'ask-session') {
    const sessionRunner = new AskSession({
      provider: provider ?? 'auto',
      model: model ?? 'gpt-4',
      strategy: strategy ?? 'default',
      maxTokens: maxTokens ?? 2048,
      contextWindow: contextWindow ?? 8192,
      temperature: temperature ?? 0.7,
      systemPrompt,
    });
    await sessionRunner.start();
    return true;
  }

  if (command === 'providers:health') {
    const config = context.getConfig();
    const providers = await context.getContainer().orchestration.providersHealth();
    print({ defaultProvider: config.DEFAULT_PROVIDER, providers }, json);
    return true;
  }

  if (command === 'tui') {
    await runTuiApp({
      orchestration: context.getContainer().orchestration,
      provider: provider ?? 'auto',
      model,
      strategy,
    });
    return true;
  }

  if (command === 'chat' || command === 'ask') {
    if (session && command !== 'ask') throw new Error('--session is supported only for ask command');

    if (command === 'ask' && session) {
      if (interactive && (!input || input.trim().length === 0)) {
        await runAskSessionInteractive({
          session,
          orchestration: context.getContainer().orchestration,
          provider: provider ?? 'auto',
          model,
          strategy,
          json,
          tui,
        });
        return true;
      }

      if (!input || input.trim().length === 0) {
        throw new Error('Missing required --input for ask command in session mode (or use --interactive)');
      }

      await runAskSessionTurn({
        session,
        rawInput: input,
        orchestration: context.getContainer().orchestration,
        provider: provider ?? 'auto',
        model,
        strategy,
        json,
        tui,
      });
      return true;
    }

    if (interactive) {
      await runInteractiveTui({
        orchestration: context.getContainer().orchestration,
        provider: provider ?? 'auto',
        model,
        strategy,
      });
      return true;
    }

    if (!input || input.trim().length === 0) throw new Error('Missing required --input for chat/ask command');
    const result = await context.getContainer().orchestration.generate({
      input,
      provider: provider ?? 'auto',
      model,
      strategy,
    });

    if (json) print(result, true);
    else if (tui) printTuiAnswer(result);
    else printChat(result);
    return true;
  }

  return false;
}
