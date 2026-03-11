import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DID, SyncLedgerEntry } from './types.js';

export class NetworkChain {
  constructor(private readonly ledgerPath = resolve('data/sync-ledger.json')) {}

  append(entry: Omit<SyncLedgerEntry, 'id' | 'ts'>): SyncLedgerEntry {
    const next: SyncLedgerEntry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      ...entry,
    };
    const current = this.read();
    current.push(next);
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    writeFileSync(this.ledgerPath, JSON.stringify(current, null, 2), 'utf8');
    return next;
  }

  read(): SyncLedgerEntry[] {
    if (!existsSync(this.ledgerPath)) return [];
    return JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as SyncLedgerEntry[];
  }

  listForActor(actor: DID): SyncLedgerEntry[] {
    return this.read().filter((e) => e.actor === actor);
  }
}
