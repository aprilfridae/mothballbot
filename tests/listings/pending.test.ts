import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDb, type Db } from '../../src/db/db.js';
import * as repo from '../../src/db/repo.js';
import { resetDb } from '../helpers/db.js';
import { sendPendingDrafts, recoverInterruptedPosts } from '../../src/listings/pending.js';

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

describe('recoverInterruptedPosts', () => {
  it('moves items stuck in "posting" (after a restart) to an error Mom can see', async () => {
    const stuck = await item('posting');
    const fine = await item('awaiting_mom');
    expect(await recoverInterruptedPosts(db)).toEqual([stuck.id]);
    expect((await repo.getItem(db, stuck.id))!.status).toBe('error');
    expect((await repo.getListings(db, stuck.id))[0].error).toContain('check eBay');
    expect((await repo.getItem(db, fine.id))!.status).toBe('awaiting_mom');
  });
});
