import { createHmac, randomUUID } from 'node:crypto';
import type { Block, DID, TradeOffer } from './types.js';

export interface TradeProtocolOptions {
  senderDid?: DID;
  signer?: (payload: string) => Promise<string> | string;
  verifier?: (payload: string, signature: string) => Promise<boolean> | boolean;
}

export class TradeProtocol {
  private readonly senderDid: DID;
  private readonly signer: (payload: string) => Promise<string>;
  private readonly verifier: (payload: string, signature: string) => Promise<boolean>;

  constructor(options: TradeProtocolOptions = {}) {
    this.senderDid = options.senderDid ?? ((process.env.MEMPHIS_DID as DID | undefined) ?? 'did:memphis:unknown');
    this.signer = async (payload: string) => {
      if (options.signer) return Promise.resolve(options.signer(payload));
      const key = process.env.MEMPHIS_VAULT_PEPPER ?? 'memphis-v4-vault-fallback';
      return createHmac('sha256', key).update(payload).digest('hex');
    };
    this.verifier = async (payload: string, signature: string) => {
      if (options.verifier) return Promise.resolve(options.verifier(payload, signature));
      const expected = await this.signer(payload);
      return expected === signature;
    };
  }

  async createOffer(blocks: Block[], recipient: DID): Promise<TradeOffer> {
    const bare = {
      id: randomUUID(),
      sender: this.senderDid,
      recipient,
      createdAt: new Date().toISOString(),
      blocks,
      status: 'offered' as const,
    };
    const signature = await this.signer(this.payloadForSign(bare));
    return { ...bare, signature };
  }

  async verifyOffer(offer: TradeOffer): Promise<boolean> {
    const { signature, ...unsigned } = offer;
    return this.verifier(this.payloadForSign(unsigned), signature);
  }

  async acceptOffer(offer: TradeOffer): Promise<void> {
    const valid = await this.verifyOffer(offer);
    if (!valid) throw new Error('invalid trade offer signature');
  }

  private payloadForSign(offer: Omit<TradeOffer, 'signature'>): string {
    return JSON.stringify({
      id: offer.id,
      sender: offer.sender,
      recipient: offer.recipient,
      createdAt: offer.createdAt,
      status: offer.status,
      payloadCid: offer.payloadCid,
      blocks: offer.blocks,
    });
  }
}
