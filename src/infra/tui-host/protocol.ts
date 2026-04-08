export const TUI_HOST_PROTOCOL_VERSION = 1 as const;

export const TUI_HOST_CAPABILITIES = [
  'guide.show',
  'telegram.send',
  'init.status',
  'health.status',
  'doctor.run',
  'agents.list',
  'agents.discover',
  'agents.show',
  'sync.status',
  'apps.list',
  'apps.show',
  'apps.plan',
  'reflect.run',
  'insights.run',
  'knowledge.status',
  'knowledge.query',
  'config.tools.list',
  'config.tools.check',
  'config.tools.pending',
  'config.surfaces.list',
  'config.surfaces.check',
  'config.surfaces.set',
  'config.surfaces.reset',
  'pulse.status',
  'cognitive.mode',
] as const;

export type TuiHostCapability = (typeof TUI_HOST_CAPABILITIES)[number];

export type TuiHostExecuteRequest = {
  type: 'execute';
  id: string;
  command: TuiHostCapability;
  args?: Record<string, unknown>;
};

export type TuiHostCancelRequest = {
  type: 'cancel';
  id: string;
};

export type TuiHostRequest = TuiHostExecuteRequest | TuiHostCancelRequest;

export type TuiHostReadyEvent = {
  type: 'ready';
  protocolVersion: typeof TUI_HOST_PROTOCOL_VERSION;
  capabilities: readonly TuiHostCapability[];
};

export type TuiHostStartedEvent = {
  type: 'started';
  id: string;
  label: string;
};

export type TuiHostLineEvent = {
  type: 'line';
  id: string;
  level: 'info' | 'warning' | 'error';
  text: string;
  temperature?: number;
  chainCount?: number;
};

export type TuiHostResultEvent = {
  type: 'result';
  id: string;
  data: unknown;
};

export type TuiHostErrorEvent = {
  type: 'error';
  id: string;
  message: string;
};

export type TuiHostCancelledEvent = {
  type: 'cancelled';
  id: string;
};

export type TuiHostEvent =
  | TuiHostReadyEvent
  | TuiHostStartedEvent
  | TuiHostLineEvent
  | TuiHostResultEvent
  | TuiHostErrorEvent
  | TuiHostCancelledEvent;

export function isTuiHostCapability(value: string): value is TuiHostCapability {
  return (TUI_HOST_CAPABILITIES as readonly string[]).includes(value);
}
