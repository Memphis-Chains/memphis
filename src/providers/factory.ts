export interface ResolvedProvider {
  provider: {
    chat: (
      messages: Array<{ role: string; content: string }>,
      options?: { model?: string; temperature?: number; max_tokens?: number },
    ) => Promise<{ content?: string }>;
  };
  model: string;
}

export async function resolveProvider(
  _opts?: Record<string, unknown>,
): Promise<ResolvedProvider | null> {
  return null;
}
