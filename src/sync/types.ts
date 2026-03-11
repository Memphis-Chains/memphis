import type { Block as MemoryBlock } from '../memory/chain.js';

export type DID = `did:${string}`;

export type Block = MemoryBlock & {
  id?: string;
  content?: string;
};

export interface TradeOffer {
  id: string;
  sender: DID;
  recipient: DID;
  createdAt: string;
  blocks: Block[];
  payloadCid?: string;
  signature: string;
  status: 'offered' | 'accepted';
  acceptedAt?: string;
}

export interface SyncLedgerEntry {
  id: string;
  ts: string;
  action: 'ipfs.push' | 'ipfs.pull' | 'ipfs.pin' | 'trade.offer' | 'trade.accept';
  actor: DID | 'system';
  cid?: string;
  offerId?: string;
  details?: Record<string, unknown>;
}
