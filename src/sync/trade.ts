import { createHmac, randomUUID } from 'node:crypto';

import type { Block, DID, TradeOffer } from './types.js';
import { MEMPHIS_DID, MEMPHIS_VAULT_PEPPER } from '../config/env-registry.js';
import { secureCompare } from '../security/constant-time.js';

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
    const envDid = MEMPHIS_DID.read(process.env);
    this.senderDid =
      options.senderDid ?? (envDid ? (envDid as DID) : 'did:memphis:unknown');
    this.signer = async (payload: string) => {
      if (options.signer) return Promise.resolve(options.signer(payload));
      const key = MEMPHIS_VAULT_PEPPER.read(process.env);
      if (!key) throw new Error('MEMPHIS_VAULT_PEPPER must be set for trade signing');
      return createHmac('sha256', key).update(payload).digest('hex');
    };
    this.verifier = async (payload: string, signature: string) => {
      if (options.verifier) return Promise.resolve(options.verifier(payload, signature));
      const expected = await this.signer(payload);
      return secureCompare(expected, signature);
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
