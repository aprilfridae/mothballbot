import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDb, type Db } from '../../src/db/db.js';
import * as repo from '../../src/db/repo.js';
import { resetDb } from '../helpers/db.js';
import {
  handleStart,
  handleShippedCallback,
  handleMomReply,
  formatSaleForMom,
  MOM_CHAT_KEY,
  type MomDeps,
} from '../../src/telegram/momBot.js';

let db: Db;
beforeAll(() => {
  db = createDb(process.env.TEST_DATABASE_URL!);
});
beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await db.end();
});

const MOM = 42;

function deps() {
  const shipped: any[] = [];
  const d: MomDeps = {
    db,
    linkCode: 'secret-code',
    markShipped: async (orderId, by, tracking) => {
      shipped.push({ orderId, by, tracking });
      return shipped.filter((s) => s.orderId === orderId).length === 1 ? 'shipped' : 'already';
    },
  };
  return { d, shipped };
}

async function linkedOrder() {
  await repo.setSetting(db, MOM_CHAT_KEY, String(MOM));
  const o = await repo.insertOrderIfNew(db, 'ebay', 'E1', {
    itemTitle: 'Nike Hoodie',
    buyer: 'sam_92',
    shipTo: { name: 'Sam Smith', line1: '123 Main St', city: 'Springfield', state: 'IL', postalCode: '62701' },
    localPickup: false,
    shipBy: new Date('2026-11-16T20:00:00Z'),
  });
  await repo.setOrderTelegramMessage(db, o!.id, 777);
  return o!;
}

describe('handleStart', () => {
  it('links Mom when the start code matches', async () => {
    const { d } = deps();
    expect(await handleStart(MOM, 'secret-code', d)).toContain("You're connected");
    expect(await repo.getSetting(db, MOM_CHAT_KEY)).toBe(String(MOM));
  });

  it('ignores a wrong code and does not let a stranger replace Mom', async () => {
    const { d } = deps();
    expect(await handleStart(99, 'guess', d)).toBeNull();
    await handleStart(MOM, 'secret-code', d);
    expect(await handleStart(99, 'guess', d)).toBeNull();
    expect(await repo.getSetting(db, MOM_CHAT_KEY)).toBe(String(MOM));
  });
});

describe('handleShippedCallback', () => {
  it('marks the order shipped for Mom and answers twice-taps politely', async () => {
    const o = await linkedOrder();
    const { d, shipped } = deps();
    expect(await handleShippedCallback(MOM, `ship:${o.id}`, d)).toBe('Marked shipped');
    expect(await handleShippedCallback(MOM, `ship:${o.id}`, d)).toBe('Already marked shipped');
    expect(shipped[0]).toEqual({ orderId: o.id, by: 'mom', tracking: null });
  });

  it('ignores taps from any other chat', async () => {
    const o = await linkedOrder();
    const { d, shipped } = deps();
    expect(await handleShippedCallback(99, `ship:${o.id}`, d)).toBeNull();
    expect(shipped).toHaveLength(0);
  });
});

describe('handleMomReply', () => {
  it('treats a tracking number replied to a sale message as shipped with tracking', async () => {
    const o = await linkedOrder();
    const { d, shipped } = deps();
    const answer = await handleMomReply(MOM, 777, '  1Z999AA10123456784 ', d);
    expect(shipped).toEqual([{ orderId: o.id, by: 'mom', tracking: '1Z999AA10123456784' }]);
    expect(answer).toContain('Got it');
  });

  it('finds the tracking number inside a sentence or a scanned barcode', async () => {
    const o = await linkedOrder();
    const { d, shipped } = deps();
    await handleMomReply(MOM, 777, 'tracking is 420627019400111899223197428490 :)', d);
    expect(shipped).toEqual([{ orderId: o.id, by: 'mom', tracking: '9400111899223197428490' }]);
  });

  it('accepts "shipped" typed as a reply too', async () => {
    const o = await linkedOrder();
    const { d, shipped } = deps();
    await handleMomReply(MOM, 777, 'Shipped!', d);
    expect(shipped).toEqual([{ orderId: o.id, by: 'mom', tracking: null }]);
  });

  it("explains when a reply isn't a tracking number", async () => {
    await linkedOrder();
    const { d, shipped } = deps();
    expect(await handleMomReply(MOM, 777, 'hello', d)).toContain("doesn't look like a tracking number");
    expect(shipped).toHaveLength(0);
  });

  it('asks Mom to reply to the sale message when she sends a loose message', async () => {
    await linkedOrder();
    const { d } = deps();
    expect(await handleMomReply(MOM, null, '1Z999AA10123456784', d)).toContain('reply to the sale message');
  });

  it('ignores other chats', async () => {
    await linkedOrder();
    const { d } = deps();
    expect(await handleMomReply(99, 777, '1Z999AA10123456784', d)).toBeNull();
  });
});

describe('formatSaleForMom', () => {
  it('includes item, buyer, address and ship-by date', () => {
    const text = formatSaleForMom({
      platform: 'ebay',
      itemTitle: 'Nike Hoodie',
      buyer: 'sam_92',
      shipTo: { name: 'Sam Smith', line1: '123 Main St', line2: 'Apt 4', city: 'Springfield', state: 'IL', postalCode: '62701' },
      localPickup: false,
      shipBy: new Date('2026-11-16T20:00:00Z'),
    });
    expect(text).toContain('Nike Hoodie');
    expect(text).toContain('sam_92');
    expect(text).toContain('123 Main St\nApt 4\nSpringfield, IL 62701');
    expect(text).toContain('Ship by: Mon, Nov 16');
  });

  it('adds the country for orders shipping abroad', () => {
    const text = formatSaleForMom({
      platform: 'ebay',
      itemTitle: 'Teacup',
      buyer: 'k',
      shipTo: { name: 'Kim', line1: '1 High St', city: 'Leeds', state: 'WYK', postalCode: 'LS1 1AA', country: 'GB' },
      localPickup: false,
      shipBy: null,
    });
    expect(text).toContain('Leeds, WYK LS1 1AA\nGB');
  });

  it('says local pickup instead of an address', () => {
    const text = formatSaleForMom({ platform: 'facebook', itemTitle: 'Lamp', buyer: 'jo', shipTo: null, localPickup: true, shipBy: null });
    expect(text).toContain('Local pickup');
  });
});

describe('linking triggers pending alerts', () => {
  it('calls onLinked after Mom connects', async () => {
    const { d } = deps();
    let linked = 0;
    await handleStart(MOM, 'secret-code', { ...d, onLinked: async () => void linked++ });
    await new Promise((r) => setTimeout(r, 10)); // runs just after the welcome reply
    expect(linked).toBe(1);
  });
});

import { routeMomText } from '../../src/telegram/momBot.js';
import { EDITING_KEY } from '../../src/telegram/momListings.js';

describe('routeMomText', () => {
  const listing = (calls: string[]) => async (_chat: number, _reply: number | null, text: string) => (calls.push(text), { answer: 'Title updated ✅' });

  it('treats a reply to a sale message as shipping, even while a listing edit is active', async () => {
    const o = await linkedOrder();
    await repo.setSetting(db, EDITING_KEY, JSON.stringify({ itemId: 1, field: 'title' }));
    const { d, shipped } = deps();
    const listingCalls: string[] = [];
    const r = await routeMomText(MOM, 777, '1Z999AA10123456784', d, listing(listingCalls));
    expect(shipped).toEqual([{ orderId: o.id, by: 'mom', tracking: '1Z999AA10123456784' }]);
    expect(listingCalls).toEqual([]);
    expect(r).toEqual({ answer: expect.stringContaining('Got it') });
    expect(await repo.getSetting(db, EDITING_KEY)).not.toBeNull();
  });

  it('sends other text to the active listing edit', async () => {
    await linkedOrder();
    const { d } = deps();
    const listingCalls: string[] = [];
    const r = await routeMomText(MOM, null, 'New title', d, listing(listingCalls));
    expect(listingCalls).toEqual(['New title']);
    expect(r).toEqual({ answer: 'Title updated ✅' });
  });

  it('falls back to the sale hint when nothing else applies', async () => {
    await linkedOrder();
    const { d } = deps();
    const r = await routeMomText(MOM, null, 'hi', d, async () => null);
    expect(r?.answer).toContain('reply to the sale message');
  });
});
