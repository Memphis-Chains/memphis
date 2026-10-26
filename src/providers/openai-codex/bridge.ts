import { CodexProviderError, runCodexChat, type CodexChatRequest } from './client.js';

// Native provider transport: one bounded JSON request on stdin; JSONL events on
// stdout. Credentials and prompts never appear in argv or error diagnostics.
const abort = new AbortController();
process.on('SIGTERM', () => abort.abort());
process.on('SIGINT', () => abort.abort());
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 16 * 1024 * 1024) {
      throw new CodexProviderError('CODEX_OUTPUT_LIMIT');
    }
  }
  const request = JSON.parse(input) as CodexChatRequest;
  const response = await runCodexChat(request, {
    detached: false,
    signal: abort.signal,
    onText: (text) => emit({ type: 'text', text }),
  });
  emit({ type: 'done', response });
}

main().catch((error: unknown) => {
  const safe =
    error instanceof CodexProviderError ? error : new CodexProviderError('CODEX_PROTOCOL_ERROR');
  emit({ type: 'error', error: { code: safe.code, message: safe.message } });
  process.exitCode = 1;
});
