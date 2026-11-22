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

/**
 * The input shape a tool's registry entry declares.
 *
 * `z.ZodObject` carries its shape as a property, so the registry's
 * schema yields the EXACT argument types a handler receives. That is what
 * lets the MCP server ask the registry for a tool's shape instead of
 * carrying a second copy of it: one contract, and the types come with it.
 *
 * The `NonNullable` matters — the registry's `inputSchema` is optional, and
 * a union with `undefined` would collapse the inference to a raw shape.
 */
export type ToolInputShape<S> =
  NonNullable<S> extends { shape: infer Shape }
    ? Shape extends import('zod').z.ZodRawShape
      ? Shape
      : import('zod').z.ZodRawShape
    : import('zod').z.ZodRawShape;
