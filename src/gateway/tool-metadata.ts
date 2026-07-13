import type { MemphisFeatureFlag } from '../infra/features/flags.js';

export type ToolTier = 0 | 1 | 2 | 3;
export type ToolCapability = 'read' | 'write' | 'network' | 'execute';

export interface ToolCliFlag {
  readonly name: string;
  readonly alias?: string;
  readonly description: string;
  readonly takesValue?: boolean;
  readonly required?: boolean;
}

export interface ToolMeta {
  name: string;
  tier: ToolTier;
  capabilities: ToolCapability[];
  description: string;
  featureFlag?: MemphisFeatureFlag;
  inputSchema?: import('zod').z.ZodTypeAny;
  helpText?: string;
  cliFlags?: readonly ToolCliFlag[];
}
