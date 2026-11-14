import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDb, type Db } from '../../src/db/db.js';
import * as repo from '../../src/db/repo.js';
import { resetDb } from '../helpers/db.js';
import { markShipped, type ShipDeps } from '../../src/orders/markShipped.js';

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

async function order() {
  const o = await repo.insertOrderIfNew(db, 'ebay', 'E1', {
    itemTitle: 'Nike Hoodie',
    buyer: 'sam',
    shipTo: null,
    localPickup: false,
    shipBy: null,
    lineItemIds: ['L1'],
  });
  return o!;
}

function deps() {
  const log = { uploads: [] as any[], discord: [] as string[], telegram: [] as string[] };
  const d: ShipDeps = {
    db,
    uploadTracking: {
      ebay: async (o, tracking, carrier) => {
        log.uploads.push({ id: o.externalId, tracking, carrier });
      },
    },
    markDiscord: async (_o, label) => {
      log.discord.push(label);
    },
    markTelegram: async (_o, label) => {
      log.telegram.push(label);
    },
  };
  return { d, log };
}

describe('markShipped', () => {
  it('is idempotent: a second tap changes nothing', async () => {
    const o = await order();
    const { d, log } = deps();
    expect(await markShipped(o.id, 'mom', null, d)).toBe('shipped');
    expect(await markShipped(o.id, 'mom', null, d)).toBe('already');
    expect(await markShipped(o.id, 'owner', null, d)).toBe('already');
    expect(log.uploads).toHaveLength(0);
    expect(log.discord).toEqual(['📦 Shipped (by Mom)']);
    expect(log.telegram).toEqual(['✅ Shipped']);
  });

  it('uploads tracking to eBay with the detected carrier', async () => {
    const o = await order();
    const { d, log } = deps();
    await markShipped(o.id, 'mom', '1Z999AA10123456784', d);
    expect(log.uploads).toEqual([{ id: 'E1', tracking: '1Z999AA10123456784', carrier: 'UPS' }]);
    expect(log.telegram).toEqual(['✅ Shipped · tracking 1Z999AA10123456784']);
  });

  it('marks shipped without calling eBay when the carrier is unknown', async () => {
    const o = await order();
    const { d, log } = deps();
    expect(await markShipped(o.id, 'owner', 'ABC123', d)).toBe('shipped');
    expect(log.uploads).toHaveLength(0);
    expect(log.discord[0]).toContain('📦 Shipped (by you)');
  });

  it('adds tracking to an order that was already marked shipped without it', async () => {
    const o = await order();
    const { d, log } = deps();
    await markShipped(o.id, 'mom', null, d);
    expect(await markShipped(o.id, 'mom', '9400111899223197428490', d)).toBe('tracking-added');
    expect(log.uploads).toEqual([{ id: 'E1', tracking: '9400111899223197428490', carrier: 'USPS' }]);
    expect(await markShipped(o.id, 'mom', '9400111899223197428490', d)).toBe('already');
    expect(log.uploads).toHaveLength(1);
  });

  it('still marks the order shipped when the tracking upload fails, and reports why', async () => {
    const o = await order();
    const { d, log } = deps();
    d.uploadTracking.ebay = async () => {
      throw new Error('Invalid tracking number');
    };
    const result = await markShipped(o.id, 'mom', '1Z999AA10123456784', d);
    expect(result).toBe('shipped');
    expect(log.telegram[0]).toContain("couldn't add tracking to eBay: Invalid tracking number");
    expect((await repo.getOrder(db, o.id))!.shippedBy).toBe('mom');
  });
});
