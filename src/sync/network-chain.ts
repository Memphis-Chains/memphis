import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
    const tmpPath = `${this.ledgerPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(current, null, 2), 'utf8');
    try {
      renameSync(tmpPath, this.ledgerPath);
    } catch (error) {
      unlinkSync(tmpPath);
      throw error;
    }
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
