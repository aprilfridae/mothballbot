import { PgBoss } from 'pg-boss';
import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import { EbayError } from '../platforms/ebay/client.js';

/** Each run re-reads this much before the last run, so nothing is missed at the edges; dedupe drops repeats. */
export const OVERLAP_MS = 10 * 60_000;
/** On the very first run, look this far back. */
export const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60_000;
const REPORT_EVERY_MS = 60 * 60_000;

export interface PollOptions<T> {
  fetch: (since: Date) => Promise<T[]>;
  handle: (items: T[]) => Promise<void>;
  report: (text: string) => Promise<void>;
  now?: () => Date;
}

function describeError(job: string, e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (e instanceof EbayError && e.isAuth) {
    return `${job}: ${msg}. The eBay refresh token probably expired; see "eBay keys" in the README to mint a new one.`;
  }
  return `${job} failed: ${msg}`;
}

/** One poll: fetch since the cursor, handle, then move the cursor. Failures are reported at most hourly. */
export async function runPoll<T>(db: Db, job: string, opts: PollOptions<T>): Promise<void> {
  const now = (opts.now ?? (() => new Date()))();
  const cursorKey = `cursor.${job}`;
  const reportKey = `status.last.${job}`;
  const stored = await repo.getSetting(db, cursorKey);
  const since = stored ? new Date(stored) : new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);

  try {
    const items = await opts.fetch(since);
    if (items.length) await opts.handle(items);
    await repo.setSetting(db, cursorKey, new Date(now.getTime() - OVERLAP_MS).toISOString());
    if (await repo.getSetting(db, reportKey)) {
      await repo.deleteSetting(db, reportKey);
      await opts.report(`✅ ${job} is working again.`);
    }
  } catch (e) {
    console.error(`${job} failed:`, e);
    const last = await repo.getSetting(db, reportKey);
    if (!last || now.getTime() - new Date(last).getTime() >= REPORT_EVERY_MS) {
      await repo.setSetting(db, reportKey, now.toISOString());
      await opts.report(describeError(job, e));
    }
  }
}

export interface ScheduledJob {
  name: string;
  run: () => Promise<void>;
}

/** Runs each job every 2 minutes through pg-boss (persisted in Postgres, so restarts don't lose the schedule). */
export async function startScheduler(databaseUrl: string, jobs: ScheduledJob[]): Promise<PgBoss> {
  const boss = new PgBoss(databaseUrl);
  boss.on('error', (e) => console.error('pg-boss error:', e));
  await boss.start();
  for (const job of jobs) {
    await boss.createQueue(job.name, { policy: 'singleton' });
    await boss.schedule(job.name, '*/2 * * * *');
    await boss.work(job.name, async () => job.run());
  }
  return boss;
}
