import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDb, type Db } from '../../src/db/db.js';
import * as repo from '../../src/db/repo.js';
import { resetDb } from '../helpers/db.js';
import { announceOrders, handleToShipReaction, type AnnounceDeps } from '../../src/discord/toShip.js';
import type { PlatformOrder } from '../../src/platforms/types.js';

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

const order: PlatformOrder = {
  externalId: 'E1',
  itemTitle: 'Nike Hoodie',
  buyer: 'sam_92',
  shipTo: { name: 'Sam Smith', line1: '123 Main St', city: 'Springfield', state: 'IL', postalCode: '62701' },
  localPickup: false,
  shipBy: new Date('2026-11-16T20:00:00Z'),
  lineItemIds: ['L1'],
};

function deps(over: Partial<AnnounceDeps> = {}) {
  const log = { toShip: [] as string[], sales: [] as string[], mom: [] as number[] };
  const d: AnnounceDeps = {
    db,
    postToShip: async (text) => {
      log.toShip.push(text);
      return `d${log.toShip.length}`;
    },
    postSale: async (text) => {
      log.sales.push(text);
    },
    notifyMom: async (o) => {
      log.mom.push(o.id);
      return 500 + o.id;
    },
    ...over,
  };
  return { d, log };
}

describe('announceOrders', () => {
  it('announces each sale once in #to-ship, #sales and to Mom, even across repeat polls', async () => {
    const { d, log } = deps();
    await announceOrders('ebay', [order], d);
    await announceOrders('ebay', [order], d);
    expect(log.toShip).toHaveLength(1);
    expect(log.sales).toEqual(['💰 Sold on eBay: Nike Hoodie']);
    expect(log.mom).toHaveLength(1);
    expect(log.toShip[0]).toContain('123 Main St');
    expect(log.toShip[0]).toContain('React 📦');
    const stored = (await db.query('SELECT discord_message_id, telegram_message_id FROM orders')).rows[0];
    expect(stored.discord_message_id).toBe('d1');
  });

  it("retries Mom's alert on the next poll if she wasn't reachable, without reposting to Discord", async () => {
    let momUp = false;
    const { d, log } = deps({
      notifyMom: async (o) => (momUp ? 500 + o.id : null),
    });
    await announceOrders('ebay', [order], d);
    momUp = true;
    await announceOrders('ebay', [order], d);
    expect(log.toShip).toHaveLength(1);
    const stored = (await db.query('SELECT telegram_message_id FROM orders')).rows[0];
    expect(Number(stored.telegram_message_id)).toBeGreaterThan(500);
  });
});

describe('handleToShipReaction', () => {
  it('marks the order shipped by the owner when 📦 is added', async () => {
    const { d } = deps();
    await announceOrders('ebay', [order], d);
    const calls: any[] = [];
    await handleToShipReaction('d1', '📦', { db, markShipped: async (...a) => (calls.push(a), 'shipped') });
    await handleToShipReaction('d1', '👍', { db, markShipped: async (...a) => (calls.push(a), 'shipped') });
    await handleToShipReaction('unknown', '📦', { db, markShipped: async (...a) => (calls.push(a), 'shipped') });
    const id = (await repo.findOrderByDiscordMessage(db, 'd1'))!.id;
    expect(calls).toEqual([[id, 'owner', null]]);
  });
});
