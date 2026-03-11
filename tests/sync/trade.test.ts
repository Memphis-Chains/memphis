import { describe, expect, it } from 'vitest';

import { TradeProtocol } from '../../src/sync/trade.js';

describe('TradeProtocol', () => {
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
});
