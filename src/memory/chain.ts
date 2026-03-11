export interface Block {
  index?: number;
  timestamp?: string;
  hash?: string;
  chain?: string;
  data?: {
    content?: string;
    tags?: string[];
    [key: string]: unknown;
  };
}
