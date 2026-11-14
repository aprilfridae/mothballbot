import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDb, type Db } from '../../src/db/db.js';
import * as repo from '../../src/db/repo.js';
import { resetDb } from '../helpers/db.js';
import { buildStatus, handleIntakeMessage, type ListingDeps, type IntakeMessage } from '../../src/discord/newListing.js';

const OWNER = 'owner-1';

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

function makeDeps() {
  const log = { saved: [] as string[], drafts: [] as any[] };
  const deps: ListingDeps = {
    db,
    ownerId: OWNER,
    downloadPhoto: async () => Buffer.from('img'),
    savePhoto: async (folder, name) => {
      const p = `/photos/${folder}/${name}`;
      log.saved.push(p);
      return p;
    },
    createDraft: async (itemId, photos, skipped) => {
      log.drafts.push({ itemId, photos: photos.length, skipped });
      return (await repo.getItem(db, itemId))!;
    },
  };
  return { deps, log };
}

function intake(over: Partial<IntakeMessage> = {}) {
  const replies: any[] = [];
  const msg: IntakeMessage = {
    id: 'm1',
    authorId: OWNER,
    content: 'Spode Blue Italian platter\n14 inch, crazing on back',
    attachments: [
      { name: 'a.jpg', contentType: 'image/jpeg', url: 'u1' },
      { name: 'b.jpg', contentType: 'image/jpeg', url: 'u2' },
      { name: 'c.heic', contentType: 'image/heic', url: 'u3' },
      { name: 'manual.pdf', contentType: 'application/pdf', url: 'u4' },
    ],
    reply: async (p) => {
      replies.push(p);
      return { id: 'reply-1' };
    },
    ...over,
  };
  return { msg, replies };
}

const embedOf = (p: any) => p.embeds[0];

async function itemWith(over: { status: repo.ItemStatus; priceCents?: number | null; research?: any; listingUrl?: string; listingError?: string }) {
  const item = await repo.insertItem(db, { title: 'Spode platter', details: 'x', priceCents: over.priceCents ?? null, photos: ['/a', '/b'] });
  await repo.setItemStatus(db, item.id, over.status);
  if (over.research) await repo.setItemResearch(db, item.id, over.research);
  if (over.listingUrl) await repo.upsertListing(db, item.id, 'ebay', { externalId: '1', url: over.listingUrl, status: 'live', error: null });
  if (over.listingError) await repo.upsertListing(db, item.id, 'ebay', { externalId: null, url: null, status: 'error', error: over.listingError });
  return { item: (await repo.getItem(db, item.id))!, listings: await repo.getListings(db, item.id) };
}

const research = { suggestedCents: 4500, lowCents: 3000, highCents: 6000, confidence: 'medium', comparables: [], reasoning: 'x' };

describe('handleIntakeMessage', () => {
  it('saves photos, replies with a status-only embed, and hands off to the pipeline', async () => {
    const { deps, log } = makeDeps();
    const { msg, replies } = intake();
    await handleIntakeMessage(msg, deps);
    expect(log.saved).toHaveLength(3);
    expect(embedOf(replies[0]).description).toContain('🔎 Researching price…');
    expect(replies[0].components).toEqual([]);
    expect(log.drafts).toEqual([{ itemId: expect.any(Number), photos: 3, skipped: ['manual.pdf'] }]);
    const item = (await repo.getItem(db, log.drafts[0].itemId))!;
    expect(item.title).toBe('Spode Blue Italian platter');
    expect(item.details).toContain('crazing on back');
    expect(item.priceCents).toBeNull();
    expect(item.discordMessageId).toBe('reply-1');
  });

  it('ignores messages from anyone but the owner', async () => {
    const { deps, log } = makeDeps();
    const { msg, replies } = intake({ authorId: 'stranger' });
    await handleIntakeMessage(msg, deps);
    expect(replies).toHaveLength(0);
    expect(log.drafts).toHaveLength(0);
  });

  it('asks for a photo when none is attached', async () => {
    const { deps } = makeDeps();
    const { msg, replies } = intake({ attachments: [] });
    await handleIntakeMessage(msg, deps);
    expect(replies[0].content).toContain('attach at least one photo');
  });

  it('replies with the usage hint when there is no text', async () => {
    const { deps, log } = makeDeps();
    const { msg, replies } = intake({ content: '' });
    await handleIntakeMessage(msg, deps);
    expect(replies[0].content).toContain('backstamp');
    expect(log.drafts).toHaveLength(0);
  });

  it('keeps at most 24 photos and notes the rest as skipped', async () => {
    const { deps, log } = makeDeps();
    const attachments = Array.from({ length: 26 }, (_, i) => ({ name: `p${i}.jpg`, contentType: 'image/jpeg', url: `u${i}` }));
    await handleIntakeMessage(intake({ attachments }).msg, deps);
    expect(log.saved).toHaveLength(24);
    expect(log.drafts[0].skipped).toEqual(['p24.jpg', 'p25.jpg']);
  });

  it("notes when the AI can't view any photo (all HEIC)", async () => {
    const { deps, log } = makeDeps();
    await handleIntakeMessage(intake({ attachments: [{ name: 'IMG_1.heic', contentType: 'image/heic', url: 'u' }] }).msg, deps);
    expect(log.drafts[0].skipped.join(' ')).toContain("AI couldn't view HEIC photos");
  });

  it('tells the owner when downloading a photo fails', async () => {
    const { deps } = makeDeps();
    deps.downloadPhoto = async () => {
      throw new Error("Couldn't download a photo from Discord (404)");
    };
    const { msg, replies } = intake();
    await handleIntakeMessage(msg, deps);
    expect(replies[0].content).toContain("Couldn't download a photo");
  });
});

describe('buildStatus', () => {
  const line = (p: any) => embedOf(p).description as string;

  it('shows the suggested price and range once sent to Mom', async () => {
    const { item, listings } = await itemWith({ status: 'awaiting_mom', priceCents: 4500, research });
    expect(line(buildStatus(item, listings, true))).toContain('📨 Sent to Mom · suggested $45.00 ($30.00–$60.00)');
  });

  it("says Mom will set the price when research found nothing", async () => {
    const { item, listings } = await itemWith({ status: 'awaiting_mom', research: { ...research, suggestedCents: null, lowCents: null, highCents: null } });
    expect(line(buildStatus(item, listings, true))).toContain("no comparables found, she'll set the price");
  });

  it('shows your own price when you gave one', async () => {
    const { item, listings } = await itemWith({ status: 'awaiting_mom', priceCents: 8500, research });
    expect(line(buildStatus(item, listings, true))).toContain('$85.00');
  });

  it('says it is waiting for Mom to connect when she is not linked', async () => {
    const { item, listings } = await itemWith({ status: 'awaiting_mom', priceCents: 4500, research });
    expect(line(buildStatus(item, listings, false))).toContain('⏳ Waiting for Mom to connect Telegram');
  });

  it.each([
    ['researching', '🔎 Researching price…'],
    ['posting', '⏫ Posting…'],
    ['rejected', '🗑 Rejected by Mom'],
  ] as const)('%s → %s', async (status, text) => {
    const { item, listings } = await itemWith({ status });
    expect(line(buildStatus(item, listings, true))).toContain(text);
  });

  it('links the live listing', async () => {
    const { item, listings } = await itemWith({ status: 'live', listingUrl: 'https://www.ebay.com/itm/9' });
    expect(line(buildStatus(item, listings, true))).toContain('✅ Posted by Mom · https://www.ebay.com/itm/9');
  });

  it("shows eBay's error while waiting on Mom", async () => {
    const { item, listings } = await itemWith({ status: 'error', listingError: 'eBay needs these item specifics: Color.' });
    expect(line(buildStatus(item, listings, true))).toContain('⚠️ Waiting on Mom: eBay needs these item specifics: Color.');
  });

  it('shows a drafting failure', async () => {
    const { item, listings } = await itemWith({ status: 'error', research: { ...research, suggestedCents: null, reasoning: "Couldn't draft this listing: boom" } });
    expect(line(buildStatus(item, listings, true))).toContain("Couldn't draft this listing: boom");
  });

  it('never has buttons', async () => {
    const { item, listings } = await itemWith({ status: 'awaiting_mom', priceCents: 4500, research });
    expect(buildStatus(item, listings, true).components).toEqual([]);
  });
});
