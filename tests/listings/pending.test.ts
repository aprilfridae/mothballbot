import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDb, type Db } from '../../src/db/db.js';
import * as repo from '../../src/db/repo.js';
import { resetDb } from '../helpers/db.js';
import { sendPendingDrafts, recoverInterrupted, deliverDraft } from '../../src/listings/pending.js';

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

async function item(status: repo.ItemStatus) {
  const i = await repo.insertItem(db, { title: 't', details: 'd', priceCents: 100, photos: [] });
  await repo.setItemStatus(db, i.id, status);
  return i;
}

describe('sendPendingDrafts', () => {
  it('warns once while Mom is not connected, then sends every waiting draft when she is', async () => {
    const a = await item('awaiting_mom');
    const b = await item('awaiting_mom');
    await item('rejected');
    await item('live');
    const reports: string[] = [];
    const sent: number[] = [];
    let linked = false;
    const opts = {
      db,
      sendDraftToMom: async (i: repo.Item) => (linked ? (sent.push(i.id), 1000 + i.id) : null),
      report: async (t: string) => void reports.push(t),
    };
    await sendPendingDrafts(opts);
    await sendPendingDrafts(opts);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('2 listing');

    linked = true;
    await sendPendingDrafts(opts);
    expect(sent).toEqual([a.id, b.id]);
    expect((await repo.getItem(db, a.id))!.telegramMessageId).toBe(1000 + a.id);
    await sendPendingDrafts(opts);
    expect(sent).toHaveLength(2);
  });
});

describe('sendPendingDrafts safety', () => {
  it('sends each draft once even when called again while a send is still uploading', async () => {
    const a = await item('awaiting_mom');
    const sent: number[] = [];
    const opts = {
      db,
      sendDraftToMom: async (i: repo.Item) => {
        await new Promise((r) => setTimeout(r, 30));
        sent.push(i.id);
        return 500 + i.id;
      },
      report: async () => {},
    };
    await Promise.all([sendPendingDrafts(opts), sendPendingDrafts(opts), sendPendingDrafts(opts)]);
    expect(sent).toEqual([a.id]);
  });

  it('keeps going past a draft that fails, reports it once, and tells the views', async () => {
    const bad = await item('awaiting_mom');
    const good = await item('awaiting_mom');
    const reports: string[] = [];
    const updated: Array<[number, number | null]> = [];
    const opts = {
      db,
      sendDraftToMom: async (i: repo.Item) => {
        if (i.id === bad.id) throw new Error('Bad Request: file too large');
        return 700;
      },
      report: async (t: string) => void reports.push(t),
      onSent: async (i: repo.Item) => void updated.push([i.id, i.telegramMessageId]),
    };
    await sendPendingDrafts(opts);
    await sendPendingDrafts(opts);
    expect(updated).toEqual([[good.id, 700]]);
    expect(reports).toEqual([expect.stringContaining('file too large')]);
  });
});

describe('deliverDraft', () => {
  it('still sends the draft text when the photo album fails', async () => {
    const texts: string[] = [];
    const id = await deliverDraft(
      async () => {
        throw new Error('Bad Request: PHOTO_INVALID_DIMENSIONS');
      },
      async (note) => (texts.push(note), 42),
    );
    expect(id).toBe(42);
    expect(texts[0]).toContain("photos couldn't be sent");
  });

  it('adds no note when the album works', async () => {
    const texts: string[] = [];
    await deliverDraft(async () => {}, async (note) => (texts.push(note), 1));
    expect(texts).toEqual(['']);
  });
});

describe('recoverInterrupted', () => {
  it('moves items stuck in "posting" (after a restart) to an error Mom can see', async () => {
    const stuck = await item('posting');
    const fine = await item('awaiting_mom');
    expect(await recoverInterrupted(db)).toEqual([stuck.id]);
    expect((await repo.getItem(db, stuck.id))!.status).toBe('error');
    expect((await repo.getListings(db, stuck.id))[0].error).toContain('check eBay');
    expect((await repo.getItem(db, fine.id))!.status).toBe('awaiting_mom');
  });

  it('marks drafts that were still being researched as needing to be posted again', async () => {
    const stuck = await item('researching');
    expect(await recoverInterrupted(db)).toEqual([stuck.id]);
    const after = (await repo.getItem(db, stuck.id))!;
    expect(after.status).toBe('error');
    expect(after.research?.reasoning).toContain('post it again');
  });

  it('marks a "posting" item live if its eBay listing actually went live before the restart', async () => {
    const stuck = await item('posting');
    await repo.upsertListing(db, stuck.id, 'ebay', { externalId: '9', url: 'https://www.ebay.com/itm/9', status: 'live', error: null });
    await recoverInterrupted(db);
    expect((await repo.getItem(db, stuck.id))!.status).toBe('live');
    expect((await repo.getListings(db, stuck.id))[0].status).toBe('live');
  });
});
