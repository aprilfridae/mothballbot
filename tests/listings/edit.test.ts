import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDb, type Db } from '../../src/db/db.js';
import * as repo from '../../src/db/repo.js';
import { resetDb } from '../helpers/db.js';
import { applyEdit, parseCondition, readDraft } from '../../src/listings/edit.js';
import type { ListingDraft } from '../../src/ai/draftListing.js';

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

const draft: ListingDraft = {
  title: 'Spode Blue Italian Platter',
  description: 'Lovely.',
  condition: 'USED_GOOD',
  brand: null,
  aspects: {},
  categoryQuery: 'platter',
};

async function item(status: repo.ItemStatus = 'awaiting_mom') {
  const i = await repo.insertItem(db, { title: 'x', details: 'x', priceCents: null, photos: [] });
  await repo.updateItemDraft(db, i.id, { ...draft, skipped: ['a.pdf'] });
  await repo.setItemStatus(db, i.id, status);
  return i;
}

describe('applyEdit', () => {
  it('sets a price from text like "$40"', async () => {
    const i = await item();
    const r = await applyEdit(db, i.id, 'price', '$40');
    expect(r.ok && r.item.priceCents).toBe(4000);
  });

  it('rejects a price that is not a number and changes nothing', async () => {
    const i = await item();
    const r = await applyEdit(db, i.id, 'price', 'cheap');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/price/i);
    expect((await repo.getItem(db, i.id))!.priceCents).toBeNull();
  });

  it('sets the condition from plain words', async () => {
    const i = await item();
    const r = await applyEdit(db, i.id, 'condition', 'used excellent');
    expect(r.ok && readDraft(r.item)!.draft.condition).toBe('USED_EXCELLENT');
  });

  it('updates item specifics and the brand, keeping skipped notes', async () => {
    const i = await item();
    const r = await applyEdit(db, i.id, 'specifics', 'Brand: Spode\nPattern: Blue Italian\nColor: Blue, White');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = readDraft(r.item)!;
      expect(d.draft.aspects).toEqual({ Brand: ['Spode'], Pattern: ['Blue Italian'], Color: ['Blue', 'White'] });
      expect(d.draft.brand).toBe('Spode');
      expect(d.skipped).toEqual(['a.pdf']);
    }
  });

  it('refuses item specifics with no "Name: value" lines instead of wiping them', async () => {
    const i = await item();
    await applyEdit(db, i.id, 'specifics', 'Pattern: Blue Italian');
    const r = await applyEdit(db, i.id, 'specifics', 'Blue');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Color: Blue');
    expect(readDraft((await repo.getItem(db, i.id))!)!.draft.aspects).toEqual({ Pattern: ['Blue Italian'] });
  });

  it('caps titles at 80 characters and refuses an empty description', async () => {
    const i = await item();
    const t = await applyEdit(db, i.id, 'title', 'Antique '.repeat(20));
    expect(t.ok && readDraft(t.item)!.draft.title.length).toBeLessThanOrEqual(80);
    const d = await applyEdit(db, i.id, 'description', '   ');
    expect(d.ok).toBe(false);
  });

  it('refuses edits once the listing is live', async () => {
    const i = await item('live');
    const r = await applyEdit(db, i.id, 'price', '50');
    expect(r).toEqual({ ok: false, error: 'This listing is already live.' });
  });

  it('allows edits after an eBay error so Mom can fix and retry', async () => {
    const i = await item('error');
    expect((await applyEdit(db, i.id, 'price', '50')).ok).toBe(true);
  });
});

describe('parseCondition', () => {
  it.each([
    ['New', 'NEW'],
    ['new other', 'NEW_OTHER'],
    ['Used – good', 'USED_GOOD'],
    ['used acceptable', 'USED_ACCEPTABLE'],
  ])('%s → %s', (text, cond) => {
    expect(parseCondition(text)).toBe(cond);
  });
});
