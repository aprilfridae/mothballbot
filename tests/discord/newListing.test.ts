import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDb, type Db } from '../../src/db/db.js';
import * as repo from '../../src/db/repo.js';
import { resetDb } from '../helpers/db.js';
import {
  buildPreview,
  handleIntakeMessage,
  handleButton,
  handleEditModal,
  type ListingDeps,
  type IntakeMessage,
} from '../../src/discord/newListing.js';
import { EbayError } from '../../src/platforms/ebay/client.js';
import type { ListingDraft } from '../../src/ai/draftListing.js';

const OWNER = 'owner-1';
const draft: ListingDraft = {
  title: 'Nike Hoodie Mens L Black',
  description: 'Great hoodie. '.repeat(200),
  condition: 'USED_GOOD',
  brand: 'Nike',
  aspects: { Size: ['L'] },
  categoryQuery: 'mens hoodie',
};

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

function makeDeps(over: Partial<ListingDeps> = {}) {
  const log = { drafts: 0, saved: [] as string[], reports: [] as string[], listings: [] as any[], uploads: 0 };
  const deps: ListingDeps = {
    db,
    ownerId: OWNER,
    draft: async () => {
      log.drafts++;
      return draft;
    },
    downloadPhoto: async () => Buffer.from('img'),
    savePhoto: async (folder, name) => {
      const p = `/photos/${folder}/${name}`;
      log.saved.push(p);
      return p;
    },
    readPhoto: async () => Buffer.from('img'),
    ebay: {
      uploadImage: async () => {
        log.uploads++;
        return 'https://i.ebayimg.com/x.jpg';
      },
      suggestCategory: async () => ({ categoryId: '155183', requiredAspects: ['Brand', 'Size'] }),
      createListing: async (input) => {
        log.listings.push(input);
        return { listingId: '999', url: 'https://www.ebay.com/itm/999' };
      },
    },
    report: async (t) => {
      log.reports.push(t);
    },
    ...over,
  };
  return { deps, log };
}

function intake(over: Partial<IntakeMessage> = {}) {
  const replies: any[] = [];
  const msg: IntakeMessage = {
    id: 'm1',
    authorId: OWNER,
    content: 'Nike hoodie size L $35',
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

function button(customId: string, userId = OWNER) {
  const calls: { deferred: number; edits: any[]; modals: any[]; updates: any[] } = {
    deferred: 0,
    edits: [],
    modals: [],
    updates: [],
  };
  return {
    calls,
    i: {
      customId,
      userId,
      deferUpdate: async () => {
        calls.deferred++;
      },
      editReply: async (p: any) => {
        calls.edits.push(p);
      },
      showModal: async (m: any) => {
        calls.modals.push(m);
      },
      update: async (p: any) => {
        calls.updates.push(p);
      },
    },
  };
}

const embedOf = (payload: any) => payload.embeds[0];
const fieldValue = (payload: any, name: string) => embedOf(payload).fields.find((f: any) => f.name === name)?.value;
const buttons = (payload: any) => payload.components.flatMap((row: any) => row.components);

async function createItem() {
  const { deps } = makeDeps();
  const { msg } = intake();
  await handleIntakeMessage(msg, deps);
  const item = (await db.query('SELECT id FROM items')).rows[0];
  return item.id as number;
}

describe('buildPreview', () => {
  it('shows title, price, condition and a description capped at 1024 characters', () => {
    const p = buildPreview({ id: 7, priceCents: 3500 }, draft, [], []);
    expect(embedOf(p).title).toBe('Nike Hoodie Mens L Black');
    expect(fieldValue(p, 'Price')).toBe('$35.00');
    expect(fieldValue(p, 'Condition')).toBe('Used – good');
    expect(fieldValue(p, 'Description').length).toBeLessThanOrEqual(1024);
    const ids = buttons(p).map((b: any) => b.custom_id);
    expect(ids).toEqual(expect.arrayContaining(['post:ebay:7', 'edit:7', 'cancel:7']));
    const etsy = buttons(p).find((b: any) => b.custom_id === 'post:etsy:7');
    expect(etsy.disabled).toBe(true);
  });

  it('shows the live link once posted and lists skipped attachments', () => {
    const p = buildPreview(
      { id: 7, priceCents: 3500 },
      draft,
      [{ platform: 'ebay', externalId: '999', url: 'https://www.ebay.com/itm/999', status: 'live', error: null }],
      ['manual.pdf'],
    );
    expect(fieldValue(p, 'eBay')).toContain('https://www.ebay.com/itm/999');
    expect(embedOf(p).footer.text).toContain('skipped: manual.pdf');
    expect(buttons(p).find((b: any) => b.custom_id === 'post:ebay:7').disabled).toBe(true);
  });
});

describe('handleIntakeMessage', () => {
  it('saves image attachments, drafts once and replies with a preview noting skipped files', async () => {
    const { deps, log } = makeDeps();
    const { msg, replies } = intake();
    await handleIntakeMessage(msg, deps);
    expect(log.saved).toHaveLength(3);
    expect(log.drafts).toBe(1);
    expect(embedOf(replies[0]).footer.text).toContain('skipped: manual.pdf');
    const item = (await db.query('SELECT * FROM items')).rows[0];
    expect(item.price_cents).toBe(3500);
    expect(item.photos).toHaveLength(3);
    expect(item.discord_message_id).toBe('reply-1');
  });

  it("notes in the preview when the AI couldn't view any of the photos (all HEIC)", async () => {
    const { deps } = makeDeps();
    const { msg, replies } = intake({ attachments: [{ name: 'IMG_1.heic', contentType: 'image/heic', url: 'u' }] });
    await handleIntakeMessage(msg, deps);
    expect(embedOf(replies[0]).footer.text).toContain("AI couldn't view HEIC photos");
  });

  it('ignores messages from anyone but the owner', async () => {
    const { deps, log } = makeDeps();
    const { msg, replies } = intake({ authorId: 'stranger' });
    await handleIntakeMessage(msg, deps);
    expect(replies).toHaveLength(0);
    expect(log.drafts).toBe(0);
  });

  it('asks for a photo when none is attached', async () => {
    const { deps } = makeDeps();
    const { msg, replies } = intake({ attachments: [] });
    await handleIntakeMessage(msg, deps);
    expect(replies[0].content).toContain('attach at least one photo');
  });

  it('replies with the usage hint when there is no price', async () => {
    const { deps, log } = makeDeps();
    const { msg, replies } = intake({ content: 'hoodie' });
    await handleIntakeMessage(msg, deps);
    expect(replies[0].content).toContain('Nike hoodie size L $35');
    expect(log.drafts).toBe(0);
  });

  it('keeps at most 24 photos and lists the rest as skipped', async () => {
    const { deps, log } = makeDeps();
    const attachments = Array.from({ length: 26 }, (_, i) => ({ name: `p${i}.jpg`, contentType: 'image/jpeg', url: `u${i}` }));
    const { msg, replies } = intake({ attachments });
    await handleIntakeMessage(msg, deps);
    expect(log.saved).toHaveLength(24);
    expect(embedOf(replies[0]).footer.text).toContain('p24.jpg');
  });

  it('tells the owner when the AI draft fails instead of crashing', async () => {
    const { deps } = makeDeps({
      draft: async () => {
        throw new Error('The AI returned a malformed listing draft.');
      },
    });
    const { msg, replies } = intake();
    await handleIntakeMessage(msg, deps);
    expect(replies[0].content).toContain('malformed listing draft');
  });
});

describe('handleButton', () => {
  it('posts to eBay and shows the listing link', async () => {
    const id = await createItem();
    const { deps, log } = makeDeps();
    const b = button(`post:ebay:${id}`);
    await handleButton(b.i, deps);
    expect(b.calls.deferred).toBe(1);
    expect(log.uploads).toBe(3);
    expect(log.listings[0]).toMatchObject({ sku: `item-${id}`, priceCents: 3500, categoryId: '155183' });
    expect(fieldValue(b.calls.edits.at(-1), 'eBay')).toContain('https://www.ebay.com/itm/999');
  });

  it("shows eBay's error, keeps Post and Edit enabled, and only reports auth failures", async () => {
    const id = await createItem();
    const { deps, log } = makeDeps();
    deps.ebay.createListing = async () => {
      throw new EbayError(400, 'Item specific Brand is missing', false);
    };
    const b = button(`post:ebay:${id}`);
    await handleButton(b.i, deps);
    const payload = b.calls.edits.at(-1);
    expect(fieldValue(payload, 'eBay')).toContain('Item specific Brand is missing');
    expect(buttons(payload).find((x: any) => x.custom_id === `post:ebay:${id}`).disabled).toBe(false);
    expect(buttons(payload).find((x: any) => x.custom_id === `edit:${id}`).disabled).toBe(false);
    expect(log.reports).toHaveLength(0);

    deps.ebay.createListing = async () => {
      throw new EbayError(401, 'eBay login failed: expired', true);
    };
    await handleButton(button(`post:ebay:${id}`).i, deps);
    expect(log.reports[0]).toContain('eBay login failed');
  });

  it('stops before posting when eBay requires item specifics the draft lacks', async () => {
    const id = await createItem();
    const { deps, log } = makeDeps();
    deps.ebay.suggestCategory = async () => ({ categoryId: '1', requiredAspects: ['Brand', 'Size', 'Color'] });
    const b = button(`post:ebay:${id}`);
    await handleButton(b.i, deps);
    expect(log.listings).toHaveLength(0);
    expect(fieldValue(b.calls.edits.at(-1), 'eBay')).toContain('Color');
  });

  it('shows a disabled Posting… state right away and ignores a second tap while posting', async () => {
    const id = await createItem();
    const { deps, log } = makeDeps();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = deps.ebay.createListing;
    deps.ebay.createListing = async (input) => {
      await gate;
      return original(input);
    };
    const first = button(`post:ebay:${id}`);
    const second = button(`post:ebay:${id}`);
    const p1 = handleButton(first.i, deps);
    await new Promise((r) => setTimeout(r, 20));
    await handleButton(second.i, deps);
    release();
    await p1;
    expect(log.listings).toHaveLength(1);
    const posting = buttons(first.calls.edits[0]).find((x: any) => x.custom_id === `post:ebay:${id}`);
    expect(posting).toMatchObject({ label: 'Posting…', disabled: true });
    expect(second.calls.deferred).toBe(1);
    expect(second.calls.edits).toHaveLength(0);
  });

  it('never replaces a live listing with an error', async () => {
    const id = await createItem();
    await repo.upsertListing(db, id, 'ebay', { externalId: '999', url: 'u', status: 'live', error: null });
    await repo.upsertListing(db, id, 'ebay', { externalId: null, url: null, status: 'error', error: 'late failure' });
    expect((await repo.getListings(db, id))[0].status).toBe('live');
  });

  it('ignores button presses from anyone but the owner', async () => {
    const id = await createItem();
    const { deps, log } = makeDeps();
    const b = button(`post:ebay:${id}`, 'stranger');
    await handleButton(b.i, deps);
    expect(b.calls.deferred).toBe(0);
    expect(log.listings).toHaveLength(0);
  });

  it('opens an edit form prefilled with the draft', async () => {
    const id = await createItem();
    const { deps } = makeDeps();
    const b = button(`edit:${id}`);
    await handleButton(b.i, deps);
    const modal = b.calls.modals[0];
    expect(modal.custom_id).toBe(`editmodal:${id}`);
    const inputs = modal.components.map((r: any) => r.components[0]);
    expect(inputs.find((x: any) => x.custom_id === 'price').value).toBe('35.00');
    expect(inputs.find((x: any) => x.custom_id === 'specifics').value).toBe('Size: L');
  });

  it('leaves the specifics box empty (no value) when the draft has no item specifics', async () => {
    const { deps } = makeDeps({ draft: async () => ({ ...draft, aspects: {} }) });
    const { msg } = intake();
    await handleIntakeMessage(msg, deps);
    const id = (await db.query('SELECT id FROM items')).rows[0].id;
    const b = button(`edit:${id}`);
    await handleButton(b.i, deps);
    const specifics = b.calls.modals[0].components.map((r: any) => r.components[0]).find((x: any) => x.custom_id === 'specifics');
    expect(specifics).not.toHaveProperty('value');
  });

  it('cancels the draft', async () => {
    const id = await createItem();
    const { deps } = makeDeps();
    const b = button(`cancel:${id}`);
    await handleButton(b.i, deps);
    expect(b.calls.updates[0].components).toEqual([]);
  });
});

describe('handleEditModal', () => {
  function modal(id: number, fields: Record<string, string>, userId = OWNER) {
    const updates: any[] = [];
    return {
      updates,
      i: {
        customId: `editmodal:${id}`,
        userId,
        field: (k: string) => fields[k] ?? '',
        update: async (p: any) => {
          updates.push(p);
        },
        reply: async (p: any) => {
          updates.push(p);
        },
      },
    };
  }

  it('saves edits and re-renders the preview', async () => {
    const id = await createItem();
    const { deps } = makeDeps();
    const m = modal(id, {
      title: 'Nike Tech Fleece Hoodie L',
      price: '$40',
      condition: 'used excellent',
      description: 'Barely worn.',
      specifics: 'Size: L\nColor: Black, Grey',
    });
    await handleEditModal(m.i, deps);
    expect(embedOf(m.updates[0]).title).toBe('Nike Tech Fleece Hoodie L');
    expect(fieldValue(m.updates[0], 'Price')).toBe('$40.00');
    const item = await repo.getItem(db, id);
    expect((item!.draft as any).aspects).toEqual({ Size: ['L'], Color: ['Black', 'Grey'] });
    expect((item!.draft as any).condition).toBe('USED_EXCELLENT');
    expect(item!.priceCents).toBe(4000);
  });

  it('rejects an invalid price or condition without saving', async () => {
    const id = await createItem();
    const { deps } = makeDeps();
    const m = modal(id, { title: 'x', price: 'cheap', condition: 'mint', description: 'y', specifics: '' });
    await handleEditModal(m.i, deps);
    expect(m.updates[0].content).toMatch(/price/i);
    expect((await repo.getItem(db, id))!.priceCents).toBe(3500);
  });
});
