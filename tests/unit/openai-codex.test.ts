import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  listConfiguredProviders,
  listModelsWithCapabilities,
} from '../../src/infra/cli/provider-capabilities.js';
import { envSchema } from '../../src/infra/config/schema.js';
import type { ChatToolDefinition } from '../../src/providers/index.js';
import { createProvider } from '../../src/providers/index.js';
import { OpenAICodexProvider } from '../../src/providers/openai-codex/adapter.js';
import { resolveCodexModel, runCodexChat } from '../../src/providers/openai-codex/client.js';
import { createConfiguredRuntimeProviders } from '../../src/providers/runtime-registry.js';

type CapturedMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

const roots: string[] = [];
const tool: ChatToolDefinition = {
  name: 'memphis_recall',
  description: 'Read Memphis memory',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};
const secretSentinel = 'SYNTHETIC_CODEX_ERROR_CREDENTIAL_DO_NOT_PUBLISH';

function createFixture(scenario = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'memphis-codex-fixture-'));
  roots.push(root);
  const binary = join(root, 'codex');
  const script = readFileSync(
    new URL('../helpers/codex-app-server-fixture.cjs', import.meta.url),
    'utf8',
  );
  writeFileSync(binary, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  chmodSync(binary, 0o700);
  writeFileSync(
    join(root, 'fixture.json'),
    JSON.stringify({ marker: 'memphis-codex-app-server-test', scenario }),
    { mode: 0o600 },
  );
  const rawEnv: NodeJS.ProcessEnv = {
    HOME: root,
    CODEX_HOME: join(root, 'codex-home'),
    CODEX_BIN: binary,
    OPENAI_AUTH_MODE: 'codex',
    PATH: process.env.PATH,
    MEMPHIS_API_TOKEN: 'synthetic-memphis-token-not-for-codex',
    OPENAI_API_KEY: 'synthetic-api-key-not-for-codex',
    MINIMAX_API_KEY: 'synthetic-minimax-key-not-for-codex',
    MEMPHIS_VAULT_PEPPER: 'synthetic-pepper-not-for-codex',
  };
  return {
    root,
    binary,
    rawEnv,
    requests(): CapturedMessage[] {
      const file = join(root, 'requests.jsonl');
      return existsSync(file)
        ? readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as CapturedMessage)
        : [];
    },
  };
}

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Fixture condition did not become true.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectStopped(root: string): Promise<void> {
  const file = join(root, 'pid');
  if (!existsSync(file)) return;
  const pid = Number(readFileSync(file, 'utf8'));
  await until(() => !isAlive(pid));
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    const file = join(root, 'pid');
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, 'utf8'));
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('OpenAI through Codex app-server', () => {
  it('registers OpenAI in the runtime, legacy factory and model listing', async () => {
    const fixture = createFixture();
    const config = envSchema.parse({ DEFAULT_PROVIDER: 'openai', OPENAI_AUTH_MODE: 'codex' });
    const { providers } = createConfiguredRuntimeProviders(config, fixture.rawEnv);
    const provider = providers.find((candidate) => candidate.name === 'openai');
    expect(provider).toBeDefined();
    expect(provider?.defaultModel()).toBe('astra-gtp6-max');
    const generated = await provider!.generate({
      input: 'fixture question',
      model: 'astra-gtp6-max',
    });
    expect(generated.providerUsed).toBe('openai');
    expect(generated.output).toBe('fixture answer');
    expect(createProvider({ name: 'openai', type: 'openai', priority: 1 })).toBeInstanceOf(
      OpenAICodexProvider,
    );
    expect(listConfiguredProviders(fixture.rawEnv).some((entry) => entry.name === 'openai')).toBe(
      true,
    );
    const models = await listModelsWithCapabilities({
      ...fixture.rawEnv,
      OLLAMA_URL: 'http://127.0.0.1:1',
    });
    expect(models).toContainEqual(
      expect.objectContaining({ provider: 'openai', model: 'astra-gtp6-max' }),
    );
    expect(models).toContainEqual(
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.6-sol-max',
        capabilities: expect.objectContaining({ context_window: 1_050_000 }),
      }),
    );
  });

  it('uses the requested Astra alias and max effort with a ChatGPT account', async () => {
    const fixture = createFixture();
    const deltas: string[] = [];
    const response = await runCodexChat(
      {
        messages: [{ role: 'user', content: 'fixture question' }],
        model: 'astra-gtp6-max',
        systemPrompt: 'Memphis remains responsible for executing its tools.',
        timeoutMs: 3000,
      },
      { rawEnv: fixture.rawEnv, onText: (text) => deltas.push(text) },
    );

    expect(response).toMatchObject({
      provider: 'openai',
      model: 'gpt-6-astra',
      content: 'fixture answer',
    });
    expect(deltas.join('')).toBe('fixture answer');
    const requests = fixture.requests();
    expect(requests.find((message) => message.method === 'initialize')).toBeDefined();
    expect(requests.findIndex((message) => message.method === 'account/read')).toBeLessThan(
      requests.findIndex((message) => message.method === 'thread/start'),
    );
    expect(requests.find((message) => message.method === 'thread/start')?.params).toMatchObject({
      model: 'gpt-6-astra',
      modelProvider: 'openai',
      ephemeral: true,
      environments: [],
      approvalPolicy: 'untrusted',
    });
    expect(requests.find((message) => message.method === 'turn/start')?.params).toMatchObject({
      effort: 'max',
    });
    await expectStopped(fixture.root);
  });

  it('maps the GPT-5.6 Sol Max preset to the official model and max effort', async () => {
    const fixture = createFixture();
    expect(resolveCodexModel('gpt-5.6-Sol Max')).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'max',
    });

    const response = await runCodexChat(
      {
        messages: [{ role: 'user', content: 'fixture question' }],
        model: 'gpt-5.6-sol-max',
        timeoutMs: 3000,
      },
      { rawEnv: fixture.rawEnv },
    );

    expect(response).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      content: 'fixture answer',
    });
    const requests = fixture.requests();
    expect(requests.find((message) => message.method === 'thread/start')?.params).toMatchObject({
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      allowProviderModelFallback: false,
    });
    expect(requests.find((message) => message.method === 'turn/start')?.params).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'max',
    });
    await expectStopped(fixture.root);
  });

  it('reports exhausted workspace credits instead of a generic turn failure', async () => {
    const fixture = createFixture('no-credits');
    const failure = await runCodexChat(
      { messages: [{ role: 'user', content: 'ping' }], timeoutMs: 3000 },
      { rawEnv: fixture.rawEnv },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/credit/i);
    // The public diagnosis must name the cause, not send the operator to logs.
    expect((failure as { code?: string }).code).toBe('CODEX_NO_CREDITS');
    await expectStopped(fixture.root);
  });

  it('reports credits exhausted mid-turn and never returns the partial text', async () => {
    const fixture = createFixture('credits-depleted-mid-turn');
    const failure = await runCodexChat(
      { messages: [{ role: 'user', content: 'ping' }], timeoutMs: 3000 },
      { rawEnv: fixture.rawEnv },
    ).catch((error: unknown) => error);

    expect((failure as { code?: string }).code).toBe('CODEX_NO_CREDITS');
    expect((failure as Error).message).not.toContain('partial');
    await expectStopped(fixture.root);
  });

  it('keeps the generic turn failure when a usage window closes but credits remain', async () => {
    const fixture = createFixture('rate-limited-not-credits');
    const failure = await runCodexChat(
      { messages: [{ role: 'user', content: 'ping' }], timeoutMs: 3000 },
      { rawEnv: fixture.rawEnv },
    ).catch((error: unknown) => error);

    expect((failure as { code?: string }).code).not.toBe('CODEX_NO_CREDITS');
    expect((failure as { code?: string }).code).toBe('CODEX_TURN_FAILED');
    await expectStopped(fixture.root);
  });

  it('keeps the tool call and the account limit both when the tool call comes first', async () => {
    const fixture = createFixture('tool-then-context-window');
    const response = await runCodexChat(
      {
        messages: [{ role: 'user', content: 'ping' }],
        model: 'astra-gtp6-max',
        tools: [tool],
        timeoutMs: 3000,
      },
      { rawEnv: fixture.rawEnv },
    );

    // The tool call is handed back to Memphis so its own loop executes it.
    expect(response.tool_calls?.[0]?.name).toBe('memphis_recall');
    expect(response.finishReason).toBe('tool_calls');
    // The usage frame arrives AFTER the tool call. Handing control back too
    // early would drop the account limit and the token usage.
    expect(response.effectiveContextWindow).toBe(258400);
    expect(response.tokens?.total).toBe(21);
    await expectStopped(fixture.root);
  });

  it('exposes the account context window so history is trimmed to the real limit', async () => {
    const fixture = createFixture('account-context-window');
    const response = await runCodexChat(
      { messages: [{ role: 'user', content: 'ping' }], timeoutMs: 3000 },
      { rawEnv: fixture.rawEnv },
    );

    // The account grants less context than the declared API limit of 1050000.
    // Trimming must follow the account value or long sessions fail upstream.
    expect(response.effectiveContextWindow).toBe(272000);
    await expectStopped(fixture.root);
  });

  it('does not pass Memphis secrets or an API key into the Codex child', async () => {
    const fixture = createFixture();
    await runCodexChat(
      { messages: [{ role: 'user', content: 'ping' }], timeoutMs: 3000 },
      { rawEnv: fixture.rawEnv },
    );
    const launch = JSON.parse(readFileSync(join(fixture.root, 'launch.json'), 'utf8')) as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(launch.argv).toContain('app-server');
    expect(launch.env.CODEX_HOME).toBe(fixture.rawEnv.CODEX_HOME);
    const start = fixture.requests().find((message) => message.method === 'thread/start');
    expect(start?.params?.config).toEqual({
      mcp_servers: { fixture_server: { enabled: false } },
      plugins: { 'fixture-plugin@example.invalid': { enabled: false } },
    });
    for (const key of [
      'OPENAI_API_KEY',
      'MINIMAX_API_KEY',
      'MEMPHIS_API_TOKEN',
      'MEMPHIS_VAULT_PEPPER',
    ]) {
      expect(launch.env).not.toHaveProperty(key);
    }
  });

  it('resolves a relative binary before changing the app-server directory', async () => {
    const fixture = createFixture();
    fixture.rawEnv.CODEX_BIN = relative(process.cwd(), fixture.binary);
    const response = await runCodexChat(
      { messages: [{ role: 'user', content: 'ping' }], timeoutMs: 3000 },
      { rawEnv: fixture.rawEnv },
    );
    expect(response.content).toBe('fixture answer');
  });

  it('refuses an unexpected built-in execution approval', async () => {
    const fixture = createFixture('builtin-approval');
    await expect(
      runCodexChat(
        { messages: [{ role: 'user', content: 'ping' }], timeoutMs: 3000 },
        { rawEnv: fixture.rawEnv },
      ),
    ).rejects.toMatchObject({ code: 'CODEX_PROTOCOL_ERROR' });
    await expectStopped(fixture.root);
  });

  it('forwards completed Memphis tool results in the next request', async () => {
    const fixture = createFixture();
    await runCodexChat(
      {
        messages: [
          { role: 'user', content: 'recall' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call-first', name: tool.name, arguments: { query: 'memory' } }],
          },
          { role: 'tool', tool_call_id: 'call-first', content: 'synthetic tool result' },
        ],
        tools: [tool],
        timeoutMs: 3000,
      },
      { rawEnv: fixture.rawEnv },
    );
    const start = fixture.requests().find((message) => message.method === 'turn/start');
    expect(JSON.stringify(start?.params?.input)).toContain('synthetic tool result');
    expect(JSON.stringify(start?.params?.input)).toContain('call-first');
  });

  it('forwards adapter cancellation to the running app-server', async () => {
    const fixture = createFixture('hang');
    const provider = new OpenAICodexProvider({ rawEnv: fixture.rawEnv });
    const controller = new AbortController();
    const pending = provider
      .chat([{ role: 'user', content: 'ping' }], { signal: controller.signal })
      .catch((error: unknown) => error);
    await until(() => fixture.requests().some((message) => message.method === 'turn/start'));
    controller.abort();
    expect(await pending).toMatchObject({ code: 'CODEX_CANCELLED' });
    await expectStopped(fixture.root);
  });

  it.each(['no-auth', 'api-key-auth'])(
    'rejects %s before sending a prompt without falling back to an API key',
    async (scenario) => {
      const fixture = createFixture(scenario);
      await expect(
        runCodexChat(
          { messages: [{ role: 'user', content: 'do not send this' }], timeoutMs: 3000 },
          { rawEnv: fixture.rawEnv },
        ),
      ).rejects.toMatchObject({ code: 'CODEX_NOT_AUTHENTICATED' });
      expect(fixture.requests().some((message) => message.method === 'thread/start')).toBe(false);
      expect(fixture.requests().some((message) => message.method === 'turn/start')).toBe(false);
      await expectStopped(fixture.root);
    },
  );

  it('rejects a silently substituted model before starting generation', async () => {
    const fixture = createFixture('model-substitution');
    await expect(
      runCodexChat(
        {
          messages: [{ role: 'user', content: 'ping' }],
          model: 'astra-gtp6-max',
          timeoutMs: 3000,
        },
        { rawEnv: fixture.rawEnv },
      ),
    ).rejects.toMatchObject({ code: 'CODEX_MODEL_UNAVAILABLE' });
    expect(fixture.requests().some((message) => message.method === 'turn/start')).toBe(false);
    await expectStopped(fixture.root);
  });

  it.each(['failed', 'interrupted', 'exit-after-text'])(
    'does not report partial text as success after %s',
    async (scenario) => {
      const fixture = createFixture(scenario);
      await expect(
        runCodexChat(
          { messages: [{ role: 'user', content: 'ping' }], timeoutMs: 3000 },
          { rawEnv: fixture.rawEnv },
        ),
      ).rejects.toThrow();
      await expectStopped(fixture.root);
    },
  );

  it.each(['rpc-error', 'stderr-error', 'malformed-line', 'failed'])(
    'keeps %s details out of public errors',
    async (scenario) => {
      const fixture = createFixture(scenario);
      const result = await runCodexChat(
        { messages: [{ role: 'user', content: 'ping' }], timeoutMs: 3000 },
        { rawEnv: fixture.rawEnv },
      ).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).not.toContain(secretSentinel);
      expect(JSON.stringify(result)).not.toContain(secretSentinel);
      expect((result as Error).cause).toBeUndefined();
      await expectStopped(fixture.root);
    },
  );

  it('returns a registered dynamic tool call for Memphis to execute', async () => {
    const fixture = createFixture('tool');
    const response = await runCodexChat(
      { messages: [{ role: 'user', content: 'recall' }], tools: [tool], timeoutMs: 3000 },
      { rawEnv: fixture.rawEnv },
    );
    expect(response.tool_calls).toEqual([
      { id: 'call-fixture', name: 'memphis_recall', arguments: { query: 'fixture question' } },
    ]);
    expect(response.finishReason).toBe('tool_calls');
    const thread = fixture.requests().find((message) => message.method === 'thread/start');
    expect(thread?.params?.dynamicTools).toEqual([
      expect.objectContaining({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }),
    ]);
    await expectStopped(fixture.root);
  });

  it.each(['unknown-tool', 'invalid-tool-args', 'array-tool-args', 'missing-call-id'])(
    'rejects %s instead of emitting an executable tool call',
    async (scenario) => {
      const fixture = createFixture(scenario);
      await expect(
        runCodexChat(
          { messages: [{ role: 'user', content: 'recall' }], tools: [tool], timeoutMs: 3000 },
          { rawEnv: fixture.rawEnv },
        ),
      ).rejects.toMatchObject({ code: 'CODEX_PROTOCOL_ERROR' });
      await expectStopped(fixture.root);
    },
  );

  it('bounds app-server output and terminates the child', async () => {
    const fixture = createFixture('output-limit');
    await expect(
      runCodexChat(
        { messages: [{ role: 'user', content: 'ping' }], timeoutMs: 3000 },
        { rawEnv: fixture.rawEnv },
      ),
    ).rejects.toMatchObject({ code: 'CODEX_OUTPUT_LIMIT' });
    await expectStopped(fixture.root);
  });

  it('terminates an unresponsive app-server on timeout', async () => {
    const fixture = createFixture('hang');
    await expect(
      runCodexChat(
        { messages: [{ role: 'user', content: 'ping' }], timeoutMs: 100 },
        { rawEnv: fixture.rawEnv },
      ),
    ).rejects.toMatchObject({ code: 'CODEX_TIMEOUT' });
    await expectStopped(fixture.root);
  });

  it('cancels an active turn and terminates the app-server', async () => {
    const fixture = createFixture('hang');
    const controller = new AbortController();
    const pending = runCodexChat(
      { messages: [{ role: 'user', content: 'ping' }], timeoutMs: 10000 },
      { rawEnv: fixture.rawEnv, signal: controller.signal },
    ).catch((error: unknown) => error);
    await until(() => fixture.requests().some((message) => message.method === 'turn/start'));
    controller.abort();
    expect(await pending).toMatchObject({ code: 'CODEX_CANCELLED' });
    await expectStopped(fixture.root);
  });

  it('does not spawn an app-server when already cancelled', async () => {
    const fixture = createFixture('hang');
    const controller = new AbortController();
    controller.abort();
    await expect(
      runCodexChat(
        { messages: [{ role: 'user', content: 'ping' }] },
        { rawEnv: fixture.rawEnv, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'CODEX_CANCELLED' });
    expect(existsSync(join(fixture.root, 'pid'))).toBe(false);
  });

  it('reports a missing binary safely without trying a shell or another provider', async () => {
    const fixture = createFixture();
    await expect(
      runCodexChat(
        { messages: [{ role: 'user', content: 'ping' }] },
        { rawEnv: { ...fixture.rawEnv, CODEX_BIN: join(fixture.root, 'absent binary; false') } },
      ),
    ).rejects.toMatchObject({ code: 'CODEX_BINARY_UNAVAILABLE' });
    expect(existsSync(join(fixture.root, 'pid'))).toBe(false);
  });

  it('exposes the OpenAI adapter with the requested default alias and forwards model overrides', async () => {
    const fixture = createFixture();
    const provider = new OpenAICodexProvider({
      model: 'astra-gtp6-max',
      rawEnv: fixture.rawEnv,
    });
    expect(provider.name).toBe('openai');
    expect(provider.isConfigured()).toBe(true);
    expect(provider.defaultModel()).toBe('astra-gtp6-max');
    const response = await provider.chat([{ role: 'user', content: 'ping' }], {
      model: 'gpt-6-astra',
    });
    expect(response.provider).toBe('openai');
    expect(response.model).toBe('gpt-6-astra');
    expect(
      fixture.requests().find((message) => message.method === 'thread/start')?.params?.model,
    ).toBe('gpt-6-astra');
  });
});
