export type ChainHealth = {
  totalBlocks: number;
  lastBlockHash: string;
  integrity: 'VALID' | 'INVALID' | string;
};

export type StatusWidgetProps = {
  provider?: string;
  model?: string;
  latency?: number;
  tokensUsed?: number;
  error?: string;
  chainHealth?: ChainHealth;
};

export function renderStatusWidget(props: StatusWidgetProps): string {
  const lines: string[] = [];

  if (props.provider) lines.push(`provider: ${props.provider}`);
  if (props.model) lines.push(`model: ${props.model}`);
  if (typeof props.latency === 'number') lines.push(`latency: ${props.latency}ms`);
  if (typeof props.tokensUsed === 'number') lines.push(`tokens: ${props.tokensUsed}`);
  if (props.error) lines.push(`error: ${props.error}`);
  if (props.chainHealth) {
    lines.push(`chain: ${props.chainHealth.totalBlocks} blocks (${props.chainHealth.integrity})`);
    lines.push(`last-hash: ${props.chainHealth.lastBlockHash}`);
  }

  return lines.join('\n');
}
