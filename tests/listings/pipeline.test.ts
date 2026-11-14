import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDb, type Db } from '../../src/db/db.js';
import * as repo from '../../src/db/repo.js';
import { resetDb } from '../helpers/db.js';
import { createDraft, postItem, rejectItem, type PipelineDeps } from '../../src/listings/pipeline.js';
import { readDraft } from '../../src/listings/edit.js';
import { EbayError } from '../../src/platforms/ebay/client.js';
import type { ListingDraft } from '../../src/ai/draftListing.js';
import type { PriceResearch } from '../../src/db/repo.js';

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
  title: 'Spode Blue Italian Oval Platter',
  description: 'Lovely platter.',
  condition: 'USED_GOOD',
  brand: 'Spode',
  aspects: { Pattern: ['Blue Italian'] },
  categoryQuery: 'china platter',
};

const research: PriceResearch = {
  suggestedCents: 6000,
  lowCents: 4000,
  highCents: 8000,
  confidence: 'medium',
  comparables: [{ title: 'Spode platter', priceCents: 5500, sold: true, site: 'eBay', url: 'https://www.ebay.com/itm/1' }],
  reasoning: 'Sold around $55-65.',
};

function makeDeps(over: Partial<PipelineDeps> = {}) {
  const log = { changes: [] as repo.ItemStatus[], listings: [] as any[], reports: [] as string[], uploads: 0 };
  const deps: PipelineDeps = {
    db,
    draft: async () => draft,
    research: async () => research,
    readPhoto: async () => Buffer.from('img'),
    ebay: {
      uploadImage: async () => (log.uploads++, 'https://i.ebayimg.com/x.jpg'),
      suggestCategory: async () => ({ categoryId: '1', requiredAspects: ['Brand'] }),
      createListing: async (input) => (log.listings.push(input), { listingId: '999', url: 'https://www.ebay.com/itm/999' }),
    },
    report: async (t) => void log.reports.push(t),
    onChange: async (item) => void log.changes.push(item.status),
    ...over,
  };
  return { deps, log };
}

async function newItem(priceCents: number | null = null) {
  return repo.insertItem(db, { title: 'Spode platter', details: 'Spode Blue Italian platter, crazing', priceCents, photos: ['/p/1.jpg'] });
}

async function readyItem(priceCents: number | null = 6000) {
  const item = await newItem(null);
  await repo.updateItemDraft(db, item.id, { ...draft, skipped: [] });
  await repo.updateItemPrice(db, item.id, priceCents);
  await repo.setItemStatus(db, item.id, 'awaiting_mom');
  return item;
}

describe('createDraft', () => {
  it('drafts, researches, uses the suggested price and hands the item to Mom', async () => {
    const item = await newItem(null);
    const { deps, log } = makeDeps();
    const done = await createDraft(item.id, [{ mime: 'image/jpeg', data: Buffer.from('x') }], [], deps);
    expect(done.status).toBe('awaiting_mom');
    expect(done.priceCents).toBe(6000);
    expect(done.research).toEqual(research);
    expect(readDraft(done)!.draft.title).toBe('Spode Blue Italian Oval Platter');
    expect(log.changes).toEqual(['awaiting_mom']);
  });

  it("keeps the owner's price and still stores the research", async () => {
    const item = await newItem(8500);
    const { deps } = makeDeps();
    const done = await createDraft(item.id, [], [], deps);
    expect(done.priceCents).toBe(8500);
    expect(done.research?.suggestedCents).toBe(6000);
  });

  it('passes the owner details to both the draft and the research', async () => {
    const item = await newItem(null);
    const seen: string[] = [];
    const { deps } = makeDeps({
      draft: async (input) => (seen.push(input.title), draft),
      research: async (input) => (seen.push(input.details), research),
    });
    await createDraft(item.id, [], [], deps);
    expect(seen.join(' ')).toContain('crazing');
  });

  it('leaves the price empty when research finds nothing', async () => {
    const item = await newItem(null);
    const { deps } = makeDeps({ research: async () => ({ ...research, suggestedCents: null, comparables: [], reasoning: "Couldn't find comparables: x" }) });
    const done = await createDraft(item.id, [], [], deps);
    expect(done.priceCents).toBeNull();
    expect(done.status).toBe('awaiting_mom');
  });

  it('reports a research service failure to #bot-status but still hands the draft to Mom', async () => {
    const item = await newItem(null);
    const { deps, log } = makeDeps({
      research: async () => ({ ...research, suggestedCents: null, comparables: [], reasoning: "Price research didn't work this time, so please set the price.", error: '400 web search is disabled' }),
    });
    const done = await createDraft(item.id, [], [], deps);
    expect(done.status).toBe('awaiting_mom');
    expect(log.reports).toEqual([expect.stringContaining('web search is disabled')]);
  });

  it('marks the item as an error (and still notifies) when drafting fails', async () => {
    const item = await newItem(null);
    const { deps, log } = makeDeps({
      draft: async () => {
        throw new Error('The AI returned a malformed listing draft.');
      },
    });
    const done = await createDraft(item.id, [], [], deps);
    expect(done.status).toBe('error');
    expect(done.research?.reasoning).toContain('malformed listing draft');
    expect(log.changes).toEqual(['error']);
  });
});

describe('postItem', () => {
  it('posts to eBay and goes live', async () => {
    const item = await readyItem();
    const { deps, log } = makeDeps();
    expect(await postItem(item.id, deps)).toBe('live');
    expect(log.listings[0]).toMatchObject({ sku: `item-${item.id}`, priceCents: 6000, categoryId: '1' });
    expect((await repo.getItem(db, item.id))!.status).toBe('live');
    expect(log.changes).toEqual(['posting', 'live']);
  });

  it("posts with the category's own condition wording", async () => {
    const item = await readyItem();
    const { deps, log } = makeDeps();
    deps.ebay.suggestCategory = async () => ({
      categoryId: '1',
      requiredAspects: [],
      conditions: [
        { conditionId: '1000', conditionDescription: 'New' },
        { conditionId: '3000', conditionDescription: 'Used' },
      ],
    });
    await postItem(item.id, deps);
    expect(log.listings[0].ebayCondition).toBe('USED_EXCELLENT');
  });

  it('refuses to post without a price', async () => {
    const item = await readyItem(null);
    const { deps, log } = makeDeps();
    expect(await postItem(item.id, deps)).toBe('blocked');
    expect(log.listings).toHaveLength(0);
    expect(log.uploads).toBe(0);
  });

  it('posts only once when tapped twice at the same time', async () => {
    const item = await readyItem();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, log } = makeDeps();
    const original = deps.ebay.createListing;
    deps.ebay.createListing = async (input) => (await gate, original(input));
    const first = postItem(item.id, deps);
    await new Promise((r) => setTimeout(r, 20));
    expect(await postItem(item.id, deps)).toBe('busy');
    release();
    expect(await first).toBe('live');
    expect(log.listings).toHaveLength(1);
  });

  it("stores eBay's error, lets Mom post again, and only reports login failures", async () => {
    const item = await readyItem();
    const { deps, log } = makeDeps();
    deps.ebay.createListing = async () => {
      throw new EbayError(400, 'Item specific Color is missing', false);
    };
    expect(await postItem(item.id, deps)).toBe('error');
    expect((await repo.getListings(db, item.id))[0].error).toBe('Item specific Color is missing');
    expect(log.reports).toHaveLength(0);

    deps.ebay.createListing = async () => {
      throw new EbayError(401, 'eBay login failed: expired', true);
    };
    expect(await postItem(item.id, deps)).toBe('error');
    expect(log.reports[0]).toContain('eBay login failed');
  });

  it("labels a failure that isn't from eBay (e.g. a missing photo file) as the bot's own", async () => {
    const item = await readyItem();
    const { deps } = makeDeps({
      readPhoto: async () => {
        throw new Error("ENOENT: no such file or directory, open '/p/1.jpg'");
      },
    });
    expect(await postItem(item.id, deps)).toBe('error');
    expect((await repo.getListings(db, item.id))[0].error).toMatch(/^Couldn't post: ENOENT/);
  });

  it('stops before posting when required item specifics are missing', async () => {
    const item = await readyItem();
    const { deps, log } = makeDeps();
    deps.ebay.suggestCategory = async () => ({ categoryId: '1', requiredAspects: ['Brand', 'Color'] });
    expect(await postItem(item.id, deps)).toBe('error');
    expect(log.listings).toHaveLength(0);
    expect((await repo.getListings(db, item.id))[0].error).toContain('Color');
  });

  it('will not post a rejected item', async () => {
    const item = await readyItem();
    const { deps } = makeDeps();
    expect(await rejectItem(item.id, deps)).toBe(true);
    expect(await postItem(item.id, deps)).toBe('busy');
  });
});

describe('rejectItem', () => {
  it('cannot reject a live item', async () => {
    const item = await readyItem();
    const { deps } = makeDeps();
    await postItem(item.id, deps);
    expect(await rejectItem(item.id, deps)).toBe(false);
    expect((await repo.getItem(db, item.id))!.status).toBe('live');
  });
});
