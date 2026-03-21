import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TradeProtocol } from '../../src/sync/trade.js';

describe('TradeProtocol', () => {
  const originalPepper = process.env.MEMPHIS_VAULT_PEPPER;

  beforeEach(() => {
    process.env.MEMPHIS_VAULT_PEPPER = 'test-trade-pepper';
  });

  afterEach(() => {
    if (originalPepper === undefined) {
      delete process.env.MEMPHIS_VAULT_PEPPER;
      return;
    }
    process.env.MEMPHIS_VAULT_PEPPER = originalPepper;
  });

  it('creates and verifies signed offer', async () => {
    const trade = new TradeProtocol({ senderDid: 'did:memphis:alpha' });
    const offer = await trade.createOffer([{ index: 1, content: 'a' }], 'did:memphis:beta');

    expect(offer.signature.length).toBeGreaterThan(16);
    await expect(trade.verifyOffer(offer)).resolves.toBe(true);
  });

  it('accepts valid offer and rejects tampered offer', async () => {
    const trade = new TradeProtocol({ senderDid: 'did:memphis:alpha' });
    const offer = await trade.createOffer([{ index: 1, content: 'b' }], 'did:memphis:beta');

    await expect(trade.acceptOffer(offer)).resolves.toBeUndefined();

    const tampered = { ...offer, blocks: [{ index: 99, content: 'evil' }] };
    await expect(trade.acceptOffer(tampered)).rejects.toThrow('invalid trade offer signature');
  });

  it('fails closed when the trade pepper is unset', async () => {
    delete process.env.MEMPHIS_VAULT_PEPPER;
    const trade = new TradeProtocol({ senderDid: 'did:memphis:alpha' });

    await expect(
      trade.createOffer([{ index: 1, content: 'c' }], 'did:memphis:beta'),
    ).rejects.toThrow('MEMPHIS_VAULT_PEPPER must be set for trade signing');
  });
});
