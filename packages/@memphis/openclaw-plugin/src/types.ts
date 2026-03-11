export interface SearchOptions {
  limit?: number;
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryEntry {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface MemorySearchManager {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  save(content: string, metadata?: Record<string, unknown>): Promise<string>;
  get(id: string): Promise<MemoryEntry | null>;
  delete(id: string): Promise<boolean>;
}

export interface MemphisPluginConfig {
  baseUrl?: string;
  timeoutMs?: number;
  defaultLimit?: number;
  apiKey?: string;
  userId?: string;
  auditLogPath?: string;
}

export interface OpenClawPluginConfig {
  memphis?: MemphisPluginConfig;
}

export interface OpenClawPluginContext {
  registerMemoryProvider(name: string, provider: MemorySearchManager): void;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}

export interface MemphisRecallHit {
  hash: string;
  content: string;
  score?: number;
  tags?: string[];
  chain?: string;
  index?: number;
}
