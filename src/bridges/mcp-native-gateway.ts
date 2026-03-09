export type NativeMcpRequest = {
  jsonrpc: '2.0';
  id: string;
  method: 'memphis.ask';
  params: {
    input: string;
    provider?: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback';
    model?: string;
  };
};

export type NativeMcpResponse = {
  jsonrpc: '2.0';
  id: string;
  result: {
    output: string;
    providerUsed: string;
    timingMs: number;
  };
};

export async function invokeNativeMcpAsk(
  request: NativeMcpRequest,
  runner: (params: NativeMcpRequest['params']) => Promise<{ output: string; providerUsed: string; timingMs: number }>,
): Promise<NativeMcpResponse> {
  if (request.jsonrpc !== '2.0') throw new Error('invalid jsonrpc version');
  if (request.method !== 'memphis.ask') throw new Error('unsupported method');
  if (!request.params?.input?.trim()) throw new Error('missing params.input');

  const result = await runner(request.params);
  return {
    jsonrpc: '2.0',
    id: request.id,
    result,
  };
}
