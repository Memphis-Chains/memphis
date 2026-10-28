import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const input = JSON.parse(readFileSync(0, 'utf8'));
const moduleRoot = input.moduleRoot;
const mod = (path) => import(pathToFileURL(resolve(moduleRoot, path)).href);
const { getDataDir, getChainPath } = await mod('config/paths.js');
const { getChainAdapterStatus } = await mod('infra/storage/chain-adapter.js');
const { getRecentBlocks } = await mod('infra/storage/rust-chain-adapter.js');
const { runMemphisJournal } = await mod('mcp/tools/journal.js');
const { runMemphisRecall } = await mod('mcp/tools/recall.js');
const { searchExactMemory } = await mod('infra/memory/exact-search.js');
const { runMemphisChainVerify } = await mod('mcp/tools/chain-verify.js');
const data = getDataDir();
assert.ok(data.startsWith(resolve(input.runtime) + sep));
assert.equal(getChainPath('journal'), resolve(data, 'chains/journal'));
const backend = getChainAdapterStatus();
assert.equal(backend.backend, 'rust-napi');
let output;
if (input.action === 'write') {
  const result = await runMemphisJournal({
    content: input.content,
    tags: ['cold-start-acceptance', input.user],
    surface: 'cli.chat',
  });
  assert.equal(result.success, true);
  output = { result };
} else if (input.action === 'inspect') {
  const recall = runMemphisRecall({ query: input.query, limit: 10, chain: 'journal' });
  const exact = searchExactMemory(input.query, 10, undefined, 'journal');
  const blocks = await getRecentBlocks('journal', 100);
  const verify = await runMemphisChainVerify({ chain: 'journal' });
  output = { recall, exact, blocks, verify };
} else if (input.action === 'turn') {
  const { createInProcessMemoryClient } = await mod('gateway/memory-client.js');
  const { runTurnRuntime } = await mod('gateway/turn-runtime.js');
  const { OllamaProvider } = await mod('providers/index.js');
  const provider = new OllamaProvider({ url: 'http://127.0.0.1:11434', model: input.model });
  const captured = [];
  const llm = {
    async complete(request) {
      captured.push({ messages: request.messages, systemPrompt: request.system });
      if (input.stubReply) return { content: input.stubReply };
      return provider.chat(request.messages, {
        systemPrompt: request.system,
        model: input.model,
        temperature: 0,
        maxTokens: 80,
        numCtx: 4096,
        signal: globalThis.AbortSignal.timeout(90000),
      });
    },
  };
  const before = await getRecentBlocks('journal', 100);
  const result = await runTurnRuntime({
    input: input.query,
    messages: [],
    llm,
    providerLabel: input.stubReply ? 'scripted-control' : 'ollama',
    model: input.model,
    memory: createInProcessMemoryClient({ surface: 'cli.chat' }),
    memoryUserId: input.user,
    conversationId: 'cold-start-synthetic',
    cognitiveRuntimeEnabled: false,
    surface: 'cli.chat',
    systemPrompt:
      'To jest test danych syntetycznych. Odpowiadaj wyłącznie na podstawie przywołanej pamięci. ' +
      'Jawna późniejsza korekta zastępuje poprzedni termin. Jeśli pamięć nie zawiera pytanego faktu, odpowiedz BRAK_DANYCH. ' +
      'Nie dopowiadaj. Nie wykonuj narzędzi. Podaj wyłącznie kod odpowiedzi, o który prosi użytkownik.',
  });
  const after = await getRecentBlocks('journal', 100);
  output = {
    result,
    captured,
    beforeCount: before.length,
    afterCount: after.length,
    blocks: after,
    verify: await runMemphisChainVerify({ chain: 'journal' }),
  };
} else {
  throw new Error('Unknown worker action');
}
console.log(
  'MEMORY_ACCEPTANCE_RESULT=' + JSON.stringify({ pid: process.pid, data, backend, ...output }),
);
