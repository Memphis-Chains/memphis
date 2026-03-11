export type ReflectionType =
  | 'performance'
  | 'pattern'
  | 'failure'
  | 'success'
  | 'alignment'
  | 'evolution';

export type ReflectionTrigger = 'scheduled' | 'threshold' | 'event' | 'manual';

export interface Reflection {
  id: string;
  type: ReflectionType;
  trigger: ReflectionTrigger;
  subject: string;
  context: Map<string, unknown>;
  findings: string[];
  insights: string[];
  recommendations: string[];
  confidence: number;
  impact: number;
  timestamp: Date;
  duration: number;
}

export interface ReflectionOptions {
  now?: Date;
  windowMs?: number;
}
