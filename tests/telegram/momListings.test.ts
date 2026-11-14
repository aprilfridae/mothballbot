import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDb, type Db } from '../../src/db/db.js';
import * as repo from '../../src/db/repo.js';
import { resetDb } from '../helpers/db.js';
import { MOM_CHAT_KEY } from '../../src/telegram/momBot.js';
import {
  formatDraftForMom,
  draftKeyboard,
  handleListingCallback,
  handleListingText,
  EDITING_KEY,
  setEditPrompt,
  type MomListingDeps,
} from '../../src/telegram/momListings.js';
import type { PipelineDeps } from '../../src/listings/pipeline.js';
import type { ListingDraft } from '../../src/ai/draftListing.js';

let db: Db;
beforeAll(() => {
  db = createDb(process.env.TEST_DATABASE_URL!);
});
beforeEach(async () => {
  await resetDb(db);
  await repo.setSetting(db, MOM_CHAT_KEY, String(MOM));
});
afterAll(async () => {
  await db.end();
});

const MOM = 42;
const draft: ListingDraft = {
  title: 'Spode Blue Italian Oval Platter',
  description: 'Lovely platter.',
  condition: 'USED_GOOD',
  brand: 'Spode',
  aspects: { Pattern: ['Blue Italian'] },
  categoryQuery: 'platter',
};
const research = {
  suggestedCents: 4500,
  lowCents: 3000,
  highCents: 6000,
  confidence: 'medium' as const,
  comparables: [
    { title: 'Spode Blue Italian platter 14"', priceCents: 4200, sold: true, site: 'eBay', url: 'https://www.ebay.com/itm/1' },
    { title: 'Blue Italian oval platter', priceCents: 5500, sold: false, site: 'Etsy', url: 'https://www.etsy.com/listing/2' },
  ],
  reasoning: 'Sold around $40-45 in similar condition.',
};

async function item(over: { status?: repo.ItemStatus; priceCents?: number | null; description?: string; photos?: string[] } = {}) {
  const i = await repo.insertItem(db, { title: 'Spode platter', details: 'x', priceCents: over.priceCents === undefined ? 4500 : over.priceCents, photos: over.photos ?? ['/a.jpg'] });
  await repo.updateItemDraft(db, i.id, { ...draft, description: over.description ?? draft.description, skipped: [] });
  await repo.setItemResearch(db, i.id, research);
  await repo.setItemStatus(db, i.id, over.status ?? 'awaiting_mom');
  return (await repo.getItem(db, i.id))!;
}

function deps() {
  const log = { listings: 0 };
  let release: (() => void) | null = null;
  const pipeline: PipelineDeps = {
    db,
    draft: async () => draft,
    research: async () => research,
    readPhoto: async () => Buffer.from('x'),
    ebay: {
      uploadImage: async () => 'https://i.ebayimg.com/x.jpg',
      suggestCategory: async () => ({ categoryId: '1', requiredAspects: [] }),
      createListing: async () => {
        log.listings++;
        if (release === null) await new Promise<void>((r) => (release = r));
        return { listingId: '9', url: 'https://www.ebay.com/itm/9' };
      },
    },
    report: async () => {},
    onChange: async () => {},
  };
  const d: MomListingDeps = { db, pipeline };
  return { d, log, releaseNow: () => (release ? release() : (release = () => {})) };
}

const readDraftDesc = (i: any) => (i.draft as any).description;
const keys = (rows: { data: string }[][]) => rows.flat().map((b) => b.data);

describe('formatDraftForMom', () => {
  it('shows title, price with range and confidence, condition, specifics, comparables and reasoning', async () => {
    const text = formatDraftForMom(await item(), null);
    expect(text).toContain('Spode Blue Italian Oval Platter');
    expect(text).toContain('💲 $45.00 (range $30.00–$60.00 · confidence medium)');
    expect(text).toContain('Used – good');
    expect(text).toContain('Pattern: Blue Italian');
    expect(text).toContain('• $42.00 sold · eBay — Spode Blue Italian platter 14" https://www.ebay.com/itm/1');
    expect(text).toContain('• $55.00 asking · Etsy');
    expect(text).toContain('Sold around $40-45');
  });

  it('stays within Telegram limits for a huge description and keeps the comparables', async () => {
    const text = formatDraftForMom(await item({ description: 'Gorgeous. '.repeat(1000) }), null);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain('https://www.ebay.com/itm/1');
  });

  it("shows the seller's own price next to what research suggests", async () => {
    const text = formatDraftForMom(await item({ priceCents: 8500 }), null);
    expect(text).toContain('💲 $85.00 (seller\'s price · research suggests $45.00, range $30.00–$60.00 · confidence medium)');
  });

  it('asks Mom for a price when there is none', async () => {
    const text = formatDraftForMom(await item({ priceCents: null }), null);
    expect(text).toContain('💲 No price yet — tap Edit → Price');
  });

  it("shows eBay's error with how to fix it", async () => {
    const text = formatDraftForMom(await item({ status: 'error' }), 'eBay needs these item specifics: Color.');
    expect(text).toContain('⚠️ eBay said: eBay needs these item specifics: Color.');
  });

  it("doesn't blame eBay for the bot's own posting failures", async () => {
    const text = formatDraftForMom(await item({ status: 'error' }), "Couldn't post: ENOENT photo missing");
    expect(text).toContain("⚠️ Couldn't post: ENOENT photo missing");
    expect(text).not.toContain('eBay said');
  });

  it('notes photos left out of the album', async () => {
    const text = formatDraftForMom(await item({ photos: ['/a.jpg', '/b.heic', '/c.heic'] }), null);
    expect(text).toContain('(+2 photos not shown)');
  });
});

describe('draftKeyboard', () => {
  it('offers Post, Edit and Reject while waiting on Mom', async () => {
    const i = await item();
    expect(keys(draftKeyboard(i))).toEqual([`lpost:${i.id}`, `ledit:${i.id}`, `lrej:${i.id}`]);
  });

  it('hides Post until there is a price', async () => {
    const i = await item({ priceCents: null });
    expect(keys(draftKeyboard(i))).toEqual([`ledit:${i.id}`, `lrej:${i.id}`]);
  });

  it('has no buttons once live or rejected', async () => {
    expect(draftKeyboard(await item({ status: 'live' }))).toEqual([]);
    expect(draftKeyboard(await item({ status: 'rejected' }))).toEqual([]);
  });
});

describe('handleListingCallback', () => {
  it('ignores everyone but Mom, and data that is not a listing action', async () => {
    const i = await item();
    const { d } = deps();
    expect(await handleListingCallback(99, `lpost:${i.id}`, d)).toBeNull();
    expect(await handleListingCallback(MOM, `ship:${i.id}`, d)).toBeNull();
  });

  it('posts once even when tapped twice', async () => {
    const i = await item();
    const { d, log, releaseNow } = deps();
    const first = handleListingCallback(MOM, `lpost:${i.id}`, d);
    await new Promise((r) => setTimeout(r, 20));
    const second = await handleListingCallback(MOM, `lpost:${i.id}`, d);
    expect(second?.answer).toBe('Already posting…');
    releaseNow();
    const r = await first;
    expect(r?.answer).toBe('✅ Live on eBay');
    expect(r?.refresh).toBe(i.id);
    expect(log.listings).toBe(1);
  });

  it('says to set a price first when there is none', async () => {
    const i = await item({ priceCents: null });
    const { d } = deps();
    expect((await handleListingCallback(MOM, `lpost:${i.id}`, d))?.answer).toBe('Set a price first: tap Edit → Price');
  });

  it('switches between the draft, field and condition buttons', async () => {
    const i = await item();
    const { d } = deps();
    expect(await handleListingCallback(MOM, `ledit:${i.id}`, d)).toMatchObject({ keyboard: 'fields', itemId: i.id });
    expect(await handleListingCallback(MOM, `lfield:${i.id}:condition`, d)).toMatchObject({ keyboard: 'conditions' });
    expect(await handleListingCallback(MOM, `lback:${i.id}`, d)).toMatchObject({ keyboard: 'draft' });
  });

  it('sets the condition from a button', async () => {
    const i = await item();
    const { d } = deps();
    const r = await handleListingCallback(MOM, `lcond:${i.id}:USED_EXCELLENT`, d);
    expect(r).toMatchObject({ refresh: i.id, keyboard: 'draft' });
    expect(((await repo.getItem(db, i.id))!.draft as any).condition).toBe('USED_EXCELLENT');
  });

  it('asks for a typed value and remembers which field is being edited', async () => {
    const i = await item();
    const { d } = deps();
    const r = await handleListingCallback(MOM, `lfield:${i.id}:price`, d);
    expect(r?.prompt).toContain('Send the new price');
    expect(r?.prompt).toContain('$45.00');
    expect(JSON.parse((await repo.getSetting(db, EDITING_KEY))!)).toEqual({ itemId: i.id, field: 'price' });
  });

  it('rejects, and then explains that the listing is rejected', async () => {
    const i = await item();
    const { d } = deps();
    expect(await handleListingCallback(MOM, `lrej:${i.id}`, d)).toMatchObject({ answer: '🗑 Rejected', refresh: i.id });
    expect((await handleListingCallback(MOM, `lpost:${i.id}`, d))?.answer).toBe('This listing is already rejected.');
    expect((await handleListingCallback(MOM, `ledit:${i.id}`, d))?.answer).toBe('This listing is already rejected.');
  });
});

describe('handleListingText', () => {
  it('applies a typed price to the field being edited and stops editing', async () => {
    const i = await item();
    const { d } = deps();
    await handleListingCallback(MOM, `lfield:${i.id}:price`, d);
    const r = await handleListingText(MOM, null, '$40', d);
    expect(r).toMatchObject({ answer: 'Price updated ✅', refresh: i.id });
    expect((await repo.getItem(db, i.id))!.priceCents).toBe(4000);
    expect(await repo.getSetting(db, EDITING_KEY)).toBeNull();
  });

  it('keeps editing and explains when the value is invalid', async () => {
    const i = await item();
    const { d } = deps();
    await handleListingCallback(MOM, `lfield:${i.id}:price`, d);
    const r = await handleListingText(MOM, null, 'cheap', d);
    expect(r?.answer).toContain("That price didn't work");
    expect(await repo.getSetting(db, EDITING_KEY)).not.toBeNull();
  });

  it('stops editing on "cancel"', async () => {
    const i = await item();
    const { d } = deps();
    await handleListingCallback(MOM, `lfield:${i.id}:title`, d);
    expect((await handleListingText(MOM, null, 'Cancel', d))?.answer).toBe('OK, no changes.');
    expect(await repo.getSetting(db, EDITING_KEY)).toBeNull();
  });

  it('only takes text that replies to the question, so a stray message is never saved as a field', async () => {
    const i = await item();
    const { d } = deps();
    await handleListingCallback(MOM, `lfield:${i.id}:description`, d);
    await setEditPrompt(db, 900);
    const stray = await handleListingText(MOM, null, '9400111899223197428490', d);
    expect(stray?.answer).toContain('reply to my question');
    expect((readDraftDesc(await repo.getItem(db, i.id)))).toBe('Lovely platter.');
    const r = await handleListingText(MOM, 900, 'Hand-painted, no chips.', d);
    expect(r?.answer).toBe('Description updated ✅');
    expect(readDraftDesc(await repo.getItem(db, i.id))).toBe('Hand-painted, no chips.');
  });

  it('accepts "cancel" even without replying', async () => {
    const i = await item();
    const { d } = deps();
    await handleListingCallback(MOM, `lfield:${i.id}:title`, d);
    await setEditPrompt(db, 900);
    expect((await handleListingText(MOM, null, 'cancel', d))?.answer).toBe('OK, no changes.');
  });

  it('does nothing when no edit is active, or for other chats', async () => {
    const i = await item();
    const { d } = deps();
    expect(await handleListingText(MOM, null, 'hello', d)).toBeNull();
    await handleListingCallback(MOM, `lfield:${i.id}:title`, d);
    expect(await handleListingText(99, null, 'hello', d)).toBeNull();
  });
});

import { earlyAnswer } from '../../src/telegram/momListings.js';

describe('earlyAnswer', () => {
  it('answers a Post tap straight away (posting can outlast Telegram’s button timeout)', () => {
    expect(earlyAnswer('lpost:7')).toBe('Posting to eBay…');
  });

  it('leaves quick actions to answer with their real result', () => {
    expect(earlyAnswer('lrej:7')).toBeNull();
    expect(earlyAnswer('ship:7')).toBeNull();
  });
});
