import { AppError } from '../../../core/errors.js';
import {
  runMemphisCognitiveModeSet,
  runMemphisConfigReload,
  runMemphisConfigSet,
  runMemphisConfigShow,
} from '../../../mcp/tools/config.js';
import { runMemphisLoopStep } from '../../../mcp/tools/loop-step.js';
import { runMemphisPresence } from '../../../mcp/tools/presence.js';
import { runMemphisRestart } from '../../../mcp/tools/restart.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';
import { optionalString, requiredRecord, requiredString } from '../input-normalization.js';

export function createRuntimeControlTools(): RuntimeToolDefinition[] {
  return [
    buildTool({
      name: 'memphis_config_show',
      description: 'Show current runtime config (redacted view of hot-reloadable env)',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Optional single config key to inspect' },
        },
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      validateInput(args) {
        return { key: optionalString(args, 'key') };
      },
      async execute(input) {
        return runMemphisConfigShow(input);
      },
    }),
    buildTool({
      name: 'memphis_config_set',
      description:
        'Set a single config key/value. Cold fields refuse; secret fields require operator passphrase.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Config key (must be in known-fields whitelist)' },
          value: { type: 'string', description: 'New value' },
          passphrase: { type: 'string', description: 'Operator passphrase if key is secret' },
        },
        required: ['key', 'value'],
      },
      isReadOnly: false,
      validateInput(args) {
        const value = args.value;
        if (typeof value !== 'string') {
          throw new AppError('VALIDATION_ERROR', 'tool value must be a string', 400);
        }
        return {
          key: requiredString(args, 'key'),
          // empty string is intentionally allowed — the LLM uses
          // `memphis_config_set { key: 'X', value: '' }` to clear a
          // mutable config field. requiredString rejected those; field
          // validation lives in runMemphisConfigSet itself.
          value,
          passphrase: optionalString(args, 'passphrase'),
        };
      },
      async execute(input) {
        return runMemphisConfigSet(input);
      },
    }),
    buildTool({
      name: 'memphis_config_reload',
      description: 'Re-read .env and hot-swap mutable fields (cold fields refuse — restart needed)',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      isReadOnly: false,
      validateInput() {
        return {};
      },
      async execute() {
        return runMemphisConfigReload();
      },
    }),
    buildTool({
      name: 'memphis_cognitive_mode_set',
      description:
        'Switch cognitive mode (A–E: ConsciousCapture / InferredDecisions / PredictivePatterns / CollectiveCoord / MetaCognitiveRef). Requires operator passphrase.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', description: 'Target mode: A | B | C | D | E' },
          passphrase: { type: 'string', description: 'Operator passphrase' },
        },
        required: ['mode'],
      },
      isReadOnly: false,
      validateInput(args) {
        return {
          mode: requiredString(args, 'mode'),
          passphrase: optionalString(args, 'passphrase'),
        };
      },
      async execute(input) {
        return runMemphisCognitiveModeSet(input);
      },
    }),
    buildTool({
      name: 'memphis_presence',
      description: 'Cross-surface presence snapshot (TUI / Telegram / HTTP / CLI activity)',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      validateInput() {
        return {};
      },
      async execute() {
        return runMemphisPresence();
      },
    }),
    buildTool({
      name: 'memphis_loop_step',
      description:
        'Cognitive loop enforcement step (Rust LoopEngine via NAPI, TS fallback if bridge unavailable)',
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'object', description: 'Current loop state' },
          action: { type: 'object', description: 'Proposed action' },
          limits: { type: 'object', description: 'Optional override limits' },
        },
        required: ['state', 'action'],
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      validateInput(args) {
        return {
          state: requiredRecord(args, 'state'),
          action: requiredRecord(args, 'action'),
          limits: args.limits as Record<string, unknown> | undefined,
        };
      },
      async execute(input) {
        return runMemphisLoopStep(input as unknown as Parameters<typeof runMemphisLoopStep>[0]);
      },
    }),
    buildTool({
      name: 'memphis_restart',
      description:
        'Request a self-restart of the Memphis daemon. Requires operator passphrase (no per-surface tier-3 session is minted via tools).',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Reason for the restart (audited)' },
          actor_id: { type: 'string', description: 'Actor identifier (audit context)' },
          passphrase: { type: 'string', description: 'Operator passphrase' },
        },
      },
      isReadOnly: false,
      isDestructive: true,
      validateInput(args) {
        return {
          reason: optionalString(args, 'reason'),
          actor_id: optionalString(args, 'actor_id'),
          passphrase: optionalString(args, 'passphrase'),
        };
      },
      async execute(input) {
        return runMemphisRestart(input);
      },
    }),
  ];
}
