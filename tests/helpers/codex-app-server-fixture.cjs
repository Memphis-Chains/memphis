/* global require, __dirname, setImmediate */
/* eslint-disable @typescript-eslint/no-require-imports -- This executable fixture is deliberately CommonJS. */
// Executed only after a unit test copies this file into a private temporary
// directory with a fixture.json marker. It never starts the real Codex binary.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
if (fixture.marker !== 'memphis-codex-app-server-test') process.exit(90);

const recordsPath = path.join(__dirname, 'requests.jsonl');
fs.writeFileSync(path.join(__dirname, 'pid'), String(process.pid));
fs.writeFileSync(
  path.join(__dirname, 'launch.json'),
  JSON.stringify({ argv: process.argv.slice(2), env: process.env }),
);
process.on('exit', () => fs.writeFileSync(path.join(__dirname, 'exited'), 'yes'));
process.on('SIGTERM', () => process.exit(0));

const scenario = fixture.scenario;
const secretSentinel = 'SYNTHETIC_CODEX_ERROR_CREDENTIAL_DO_NOT_PUBLISH';
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => write({ id, result });
const notify = (method, params) => write({ method, params });
const threadId = 'thread-fixture';
const turnId = 'turn-fixture';
const itemId = 'message-fixture';
const delta = (text) =>
  notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: text });
const completedItem = (text) =>
  notify('item/completed', {
    threadId,
    turnId,
    item: { type: 'agentMessage', id: itemId, text },
  });
const completedTurn = (status = 'completed') =>
  notify('turn/completed', {
    threadId,
    turn: {
      id: turnId,
      status,
      items: [],
      error:
        status === 'failed'
          ? { message: secretSentinel, codexErrorInfo: 'other', additionalDetails: null }
          : null,
    },
  });

function runTurn() {
  switch (scenario) {
    case 'no-credits':
      // Workspace credits are exhausted before the turn produces any output.
      notify('account/rateLimits/updated', {
        rateLimits: {
          limitId: 'premium',
          limitName: null,
          normalModelSlug: null,
          primary: null,
          secondary: null,
          credits: { hasCredits: false, unlimited: false, balance: null },
          individualLimit: null,
          spendControlReached: null,
          planType: null,
          rateLimitReachedType: 'workspace_member_credits_depleted',
        },
      });
      completedTurn('failed');
      return;
    case 'credits-depleted-mid-turn':
      delta('partial');
      notify('account/rateLimits/updated', {
        rateLimits: {
          credits: { hasCredits: false, unlimited: false, balance: null },
          rateLimitReachedType: 'workspace_member_credits_depleted',
        },
      });
      completedTurn('failed');
      return;
    case 'tool-then-context-window':
      // The tool call arrives BEFORE the usage frame, exactly as the real
      // server orders it. The account limit is only known afterwards.
      write({
        id: 79,
        method: 'item/tool/call',
        params: {
          threadId,
          turnId,
          callId: 'call-fixture',
          tool: 'memphis_recall',
          arguments: { query: 'fixture question' },
        },
      });
      notify('thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: {
          total: { totalTokens: 21, inputTokens: 16, cachedInputTokens: 0, outputTokens: 5 },
          last: { totalTokens: 21, inputTokens: 16, cachedInputTokens: 0, outputTokens: 5 },
          modelContextWindow: 258400,
        },
      });
      return;
    case 'account-context-window':
      // The account context window differs from the declared API limit.
      delta('fixture ');
      delta('answer');
      completedItem('fixture answer');
      notify('thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: {
          total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
          last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
          modelContextWindow: 272000,
        },
      });
      completedTurn();
      return;
    case 'rate-limited-not-credits':
      // Credits are present; a rolling usage window is what closed.
      notify('account/rateLimits/updated', {
        rateLimits: {
          credits: { hasCredits: true, unlimited: false, balance: '10.00' },
          rateLimitReachedType: 'rate_limit_reached',
        },
      });
      completedTurn('failed');
      return;
    case 'hang':
      return;
    case 'malformed-line':
      process.stdout.write(`${secretSentinel}\n`);
      return;
    case 'stderr-error':
      process.stderr.write(`${secretSentinel}\n`);
      process.exit(1);
      return;
    case 'output-limit':
      delta('x'.repeat(2 * 1024 * 1024));
      return;
    case 'failed':
    case 'interrupted':
      delta('Partial text that must not become a successful answer.');
      completedItem('Partial text that must not become a successful answer.');
      completedTurn(scenario);
      return;
    case 'exit-after-text':
      delta('Partial text that must not become a successful answer.');
      completedItem('Partial text that must not become a successful answer.');
      process.exit(0);
      return;
    case 'tool':
    case 'unknown-tool':
    case 'invalid-tool-args':
    case 'array-tool-args':
    case 'missing-call-id':
      write({
        id: 77,
        method: 'item/tool/call',
        params: {
          threadId,
          turnId,
          callId: scenario === 'missing-call-id' ? undefined : 'call-fixture',
          tool: scenario === 'unknown-tool' ? 'unregistered_shell' : 'memphis_recall',
          arguments:
            scenario === 'invalid-tool-args'
              ? '{"query":'
              : scenario === 'array-tool-args'
                ? ['unexpected']
                : { query: 'fixture question' },
        },
      });
      return;
    case 'builtin-approval':
      write({
        id: 78,
        method: 'item/commandExecution/requestApproval',
        params: { threadId, turnId, itemId: 'shell-fixture', command: 'do-not-execute' },
      });
      return;
    default:
      delta('fixture ');
      delta('answer');
      completedItem('fixture answer');
      notify('thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: {
          total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
          last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
          modelContextWindow: 100000,
        },
      });
      completedTurn();
  }
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(recordsPath, `${line}\n`);
  switch (message.method) {
    case 'initialize':
      if (scenario === 'rpc-error') {
        write({ id: message.id, error: { code: -32001, message: secretSentinel } });
      } else {
        reply(message.id, { userAgent: 'memphis-test-fixture' });
      }
      break;
    case 'account/read':
      reply(message.id, {
        account:
          scenario === 'no-auth'
            ? null
            : scenario === 'api-key-auth'
              ? { type: 'apiKey' }
              : { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' },
        requiresOpenaiAuth: true,
      });
      break;
    case 'config/read':
      reply(message.id, {
        config: {
          mcp_servers: { fixture_server: { command: 'must-not-start' } },
          plugins: { 'fixture-plugin@example.invalid': { enabled: true } },
        },
        origins: {},
      });
      break;
    case 'model/list':
      reply(message.id, {
        data: [
          {
            id: 'gpt-6-astra',
            model: 'gpt-6-astra',
            displayName: 'Fixture Astra',
            supportedReasoningEfforts: [{ reasoningEffort: 'max', description: 'Maximum' }],
            defaultReasoningEffort: 'max',
          },
        ],
        nextCursor: null,
      });
      break;
    case 'thread/start':
      reply(message.id, {
        thread: { id: threadId, turns: [] },
        model: scenario === 'model-substitution' ? 'different-model' : message.params.model,
        modelProvider: 'openai',
        serviceTier: null,
        cwd: __dirname,
        approvalPolicy: 'untrusted',
        sandbox: { type: 'readOnly' },
        reasoningEffort: 'max',
      });
      break;
    case 'turn/start':
      reply(message.id, { turn: { id: turnId, items: [], status: 'inProgress', error: null } });
      setImmediate(runTurn);
      break;
    case 'turn/interrupt':
      reply(message.id, {});
      break;
    default:
      if (message.id !== undefined && message.method) {
        write({
          id: message.id,
          error: { code: -32601, message: `Unsupported fixture method: ${message.method}` },
        });
      }
  }
});
