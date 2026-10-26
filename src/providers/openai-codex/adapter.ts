import {
  CODEX_SUPPORTED_MODEL_PRESETS,
  codexBinaryAvailable,
  DEFAULT_CODEX_MODEL,
  listAccountModelSlugs,
  readAccountContextWindow,
  resolveCodexModel,
  runCodexChat,
} from './client.js';
import type { ChatMessage, ChatOptions, ChatResponse, Provider } from '../index.js';

/** ChatGPT/Codex account transport. It never falls back to API-key billing. */
export class OpenAICodexProvider implements Provider {
  readonly name = 'openai';
  private readonly rawEnv: NodeJS.ProcessEnv;
  private readonly model: string;

  constructor(config: { model?: string; rawEnv?: NodeJS.ProcessEnv } = {}) {
    this.rawEnv = config.rawEnv ?? process.env;
    this.model = config.model ?? this.rawEnv.OPENAI_MODEL ?? DEFAULT_CODEX_MODEL;
  }

  isConfigured(): boolean {
    return codexBinaryAvailable(this.rawEnv);
  }

  async isAvailable(): Promise<boolean> {
    // Local readiness only. Account entitlement is verified by a completed turn.
    return this.isConfigured();
  }

  /**
   * Context window the logged-in account is granted for this model, read from
   * the local Codex catalog. It is a local file read — no request leaves the
   * machine — so it is safe to call while listing provider status.
   */
  accountContextWindow(model = this.model): number | undefined {
    return readAccountContextWindow(this.rawEnv, resolveCodexModel(model).model);
  }

  async listModels(): Promise<string[]> {
    // Supported presets plus the models this account may actually run: the
    // catalog the Codex CLI maintains is the only source that knows about
    // models released after Memphis was built.
    return [
      ...new Set([
        this.model,
        ...CODEX_SUPPORTED_MODEL_PRESETS,
        ...listAccountModelSlugs(this.rawEnv),
      ]),
    ];
  }

  defaultModel(): string {
    return this.model;
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
    return runCodexChat(
      {
        messages,
        model: opts?.model ?? this.model,
        systemPrompt: opts?.systemPrompt,
        tools: opts?.tools,
      },
      { rawEnv: this.rawEnv, signal: opts?.signal },
    );
  }
}
