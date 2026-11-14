import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createDb, migrate, type Db } from '../../src/db/db.js';
import * as repo from '../../src/db/repo.js';
import { resetDb } from '../helpers/db.js';

let db: Db;
beforeAll(async () => {
  db = createDb(process.env.TEST_DATABASE_URL!);
});
beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await db.end();
});

describe('migrate', () => {
  it('is idempotent', async () => {
    await migrate(db);
    await migrate(db);
  });
});

describe('repo', () => {
  it('inserts a message only once per external id', async () => {
    const conv = await repo.upsertConversation(db, 'ebay', 'c1', 'sam_92');
    const first = await repo.insertMessageIfNew(db, conv.id, 'm1', true, 'hi', new Date());
    const second = await repo.insertMessageIfNew(db, conv.id, 'm1', true, 'hi', new Date());
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('keeps the thread id across conversation upserts', async () => {
    const conv = await repo.upsertConversation(db, 'ebay', 'c1', 'sam_92');
    expect(conv.discordThreadId).toBeNull();
    await repo.setConversationThread(db, conv.id, 'thread-1');
    const again = await repo.upsertConversation(db, 'ebay', 'c1', 'sam_92');
    expect(again.id).toBe(conv.id);
    expect(again.discordThreadId).toBe('thread-1');
  });

  it('inserts an order only once per external id', async () => {
    const data = { itemTitle: 'Hoodie', buyer: 'sam', shipTo: null, localPickup: true, shipBy: null };
    const first = await repo.insertOrderIfNew(db, 'ebay', 'o1', data);
    const second = await repo.insertOrderIfNew(db, 'ebay', 'o1', data);
    expect(first?.itemTitle).toBe('Hoodie');
    expect(second).toBeNull();
  });

  it('marks an order shipped only once', async () => {
    const data = { itemTitle: 'Hoodie', buyer: 'sam', shipTo: null, localPickup: true, shipBy: null };
    const order = (await repo.insertOrderIfNew(db, 'ebay', 'o1', data))!;
    expect(await repo.markOrderShippedRow(db, order.id, 'mom', null)).toBe(true);
    expect(await repo.markOrderShippedRow(db, order.id, 'owner', null)).toBe(false);
    const stored = await repo.getOrder(db, order.id);
    expect(stored?.shippedBy).toBe('mom');
  });

  it('finds an order by its Telegram message', async () => {
    const data = { itemTitle: 'Hoodie', buyer: 'sam', shipTo: null, localPickup: true, shipBy: null };
    const order = (await repo.insertOrderIfNew(db, 'ebay', 'o1', data))!;
    await repo.setOrderTelegramMessage(db, order.id, 555);
    expect((await repo.findOrderByTelegramMessage(db, 555))?.id).toBe(order.id);
  });

  it('stores items, drafts, listings and settings', async () => {
    const item = await repo.insertItem(db, { title: 'Hoodie', priceCents: 3500, photos: ['/p/1.jpg'] });
    await repo.updateItemDraft(db, item.id, { title: 'Nike Hoodie' });
    await repo.upsertListing(db, item.id, 'ebay', { externalId: null, url: null, status: 'error', error: 'bad' });
    await repo.upsertListing(db, item.id, 'ebay', { externalId: '123', url: 'u', status: 'live', error: null });
    const got = await repo.getItem(db, item.id);
    expect(got?.draft).toEqual({ title: 'Nike Hoodie' });
    expect(await repo.getListings(db, item.id)).toEqual([
      { platform: 'ebay', externalId: '123', url: 'u', status: 'live', error: null },
    ]);
    await repo.setSetting(db, 'k', 'v');
    expect(await repo.getSetting(db, 'k')).toBe('v');
    expect(await repo.getSetting(db, 'missing')).toBeNull();
  });
});
