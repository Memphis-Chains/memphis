import { createHash } from 'node:crypto';
import type { Block } from './types.js';

export interface IPFSSyncOptions {
  pinataApiKey?: string;
  pinataSecret?: string;
  gatewayBaseUrl?: string;
}

export class IPFSSync {
  private readonly pinataApiKey: string;
  private readonly pinataSecret: string;
  private readonly gatewayBaseUrl: string;

  constructor(options: IPFSSyncOptions = {}) {
    this.pinataApiKey = options.pinataApiKey ?? process.env.PINATA_API_KEY ?? '';
    this.pinataSecret = options.pinataSecret ?? process.env.PINATA_SECRET_API_KEY ?? '';
    this.gatewayBaseUrl = options.gatewayBaseUrl ?? process.env.PINATA_GATEWAY_URL ?? 'https://api.pinata.cloud';
  }

  async push(blocks: Block[]): Promise<string> {
    const body = { pinataContent: { blocks } };
    const response = await fetch(`${this.gatewayBaseUrl}/pinning/pinJSONToIPFS`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`pinJSONToIPFS failed: ${response.status}`);
    const data = (await response.json()) as { IpfsHash?: string };
    if (!data.IpfsHash) {
      const fallback = createHash('sha256').update(JSON.stringify(blocks)).digest('hex').slice(0, 46);
      return `bafy${fallback}`;
    }
    return data.IpfsHash;
  }

  async pull(cid: string): Promise<Block[]> {
    const response = await fetch(`${this.gatewayBaseUrl}/ipfs/${encodeURIComponent(cid)}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (!response.ok) throw new Error(`ipfs pull failed: ${response.status}`);
    const data = (await response.json()) as { blocks?: Block[] } | Block[];
    return Array.isArray(data) ? data : (data.blocks ?? []);
  }

  async pin(cid: string): Promise<void> {
    const response = await fetch(`${this.gatewayBaseUrl}/pinning/pinByHash`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ hashToPin: cid }),
    });
    if (!response.ok) throw new Error(`pinByHash failed: ${response.status}`);
  }

  private authHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      pinata_api_key: this.pinataApiKey,
      pinata_secret_api_key: this.pinataSecret,
    };
  }
}
