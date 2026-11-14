import { describe, it, expect } from 'vitest';
import { itemIdFromSku } from '../../src/orders/sku.js';

describe('itemIdFromSku', () => {
  it('maps the bot SKU back to its item', () => {
    expect(itemIdFromSku('item-12')).toBe(12);
  });
  it('ignores listings the bot did not create', () => {
    expect(itemIdFromSku('MY-OLD-SKU')).toBeNull();
    expect(itemIdFromSku(null)).toBeNull();
  });
});

import { beforeAll, beforeEach, afterAll } from 'vitest';
import { createDb, type Db } from '../../src/db/db.js';
import * as repo from '../../src/db/repo.js';
import { resetDb } from '../helpers/db.js';
import { salePhoto } from '../../src/orders/sku.js';

describe('salePhoto', () => {
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

  it("finds the first JPEG/PNG/WebP photo of the sold item", async () => {
    const item = await repo.insertItem(db, { title: 't', details: 'd', priceCents: 1, photos: ['/p/a.heic', '/p/b.jpg', '/p/c.png'] });
    expect(await salePhoto(db, `item-${item.id}`)).toBe('/p/b.jpg');
  });

  it('returns null for sales the bot did not list', async () => {
    expect(await salePhoto(db, 'OTHER')).toBeNull();
    expect(await salePhoto(db, 'item-999')).toBeNull();
  });
});
