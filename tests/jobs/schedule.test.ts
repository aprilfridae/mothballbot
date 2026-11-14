import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDb, type Db } from '../../src/db/db.js';
import * as repo from '../../src/db/repo.js';
import { resetDb } from '../helpers/db.js';
import { runPoll, OVERLAP_MS, FIRST_RUN_LOOKBACK_MS } from '../../src/jobs/schedule.js';
import { EbayError } from '../../src/platforms/ebay/client.js';

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

const NOW = new Date('2026-11-13T20:00:00Z');

describe('runPoll', () => {
  it('starts from a one-day lookback and advances the cursor to just before this run after success', async () => {
    const seen: Date[] = [];
    await runPoll(db, 'poll-ebay-orders', {
      fetch: async (since) => (seen.push(since), ['o1']),
      handle: async () => {},
      report: async () => {},
      now: () => NOW,
    });
    expect(seen[0]).toEqual(new Date(NOW.getTime() - FIRST_RUN_LOOKBACK_MS));
    expect(await repo.getSetting(db, 'cursor.poll-ebay-orders')).toBe(new Date(NOW.getTime() - OVERLAP_MS).toISOString());
  });

  it('keeps the cursor unchanged when handling fails', async () => {
    await repo.setSetting(db, 'cursor.poll-ebay-messages', '2026-11-13T19:00:00.000Z');
    await runPoll(db, 'poll-ebay-messages', {
      fetch: async () => ['m1'],
      handle: async () => {
        throw new Error('Discord down');
      },
      report: async () => {},
      now: () => NOW,
    });
    expect(await repo.getSetting(db, 'cursor.poll-ebay-messages')).toBe('2026-11-13T19:00:00.000Z');
  });

  it('reports a failure once per hour per job', async () => {
    const reports: string[] = [];
    let now = NOW;
    const opts = {
      fetch: async (): Promise<string[]> => {
        throw new EbayError(401, 'eBay login failed: invalid_grant', true);
      },
      handle: async () => {},
      report: async (t: string) => {
        reports.push(t);
      },
      now: () => now,
    };
    await runPoll(db, 'poll-ebay-messages', opts);
    now = new Date(NOW.getTime() + 30 * 60_000);
    await runPoll(db, 'poll-ebay-messages', opts);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('eBay login failed');
    expect(reports[0]).toContain('README');
    now = new Date(NOW.getTime() + 61 * 60_000);
    await runPoll(db, 'poll-ebay-messages', opts);
    expect(reports).toHaveLength(2);
  });

  it('posts a recovery note after a reported failure clears', async () => {
    const reports: string[] = [];
    let fail = true;
    const opts = {
      fetch: async (): Promise<string[]> => {
        if (fail) throw new Error('boom');
        return [];
      },
      handle: async () => {},
      report: async (t: string) => {
        reports.push(t);
      },
      now: () => NOW,
    };
    await runPoll(db, 'poll-ebay-orders', opts);
    fail = false;
    await runPoll(db, 'poll-ebay-orders', opts);
    await runPoll(db, 'poll-ebay-orders', opts);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toContain('working again');
  });
});
