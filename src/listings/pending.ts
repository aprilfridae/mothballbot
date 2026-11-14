import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import type { Item } from '../db/repo.js';

const DRAFTS_WARNED = 'telegram.draftsWarned';

export interface PendingDeps {
  db: Db;
  sendDraftToMom: (item: Item) => Promise<number | null>;
  report: (text: string) => Promise<void>;
  /** Called after a draft reached Mom, so Discord can say "Sent to Mom". */
  onSent?: (item: Item) => Promise<void>;
}

// One sender at a time: the album upload takes seconds, and a second caller (the poll, /start, a new draft)
// must not send the same item again before its message id is saved.
let queue: Promise<void> = Promise.resolve();

/** Sends Mom every draft waiting on her that she hasn't received (e.g. made before she connected). */
export function sendPendingDrafts(deps: PendingDeps): Promise<void> {
  const run = queue.then(() => sendPendingOnce(deps));
  queue = run.catch(() => {});
  return run;
}

async function sendPendingOnce(deps: PendingDeps): Promise<void> {
  const pending = await repo.itemsAwaitingMomWithoutTelegram(deps.db);
  for (const item of pending) {
    let messageId: number | null;
    try {
      messageId = await deps.sendDraftToMom(item);
    } catch (e) {
      // Report each broken draft once; keep going so it doesn't block the others.
      const key = `telegram.draftFailed.${item.id}`;
      if (!(await repo.getSetting(deps.db, key))) {
        await repo.setSetting(deps.db, key, new Date().toISOString());
        await deps.report(`Couldn't send listing #${item.id} to Mom on Telegram: ${(e as Error).message}. It will keep retrying.`);
      }
      continue;
    }
    if (messageId === null) {
      if (!(await repo.getSetting(deps.db, DRAFTS_WARNED))) {
        await repo.setSetting(deps.db, DRAFTS_WARNED, new Date().toISOString());
        await deps.report(
          `Mom isn't connected on Telegram yet, so ${pending.length} listing draft(s) are waiting for her. Send her the start link (README, step 3).`,
        );
      }
      return;
    }
    await repo.setItemTelegramMessage(deps.db, item.id, messageId);
    await repo.deleteSetting(deps.db, `telegram.draftFailed.${item.id}`);
    await repo.deleteSetting(deps.db, DRAFTS_WARNED);
    if (deps.onSent) {
      try {
        await deps.onSent((await repo.getItem(deps.db, item.id))!);
      } catch (e) {
        console.error(`Updating views after sending item #${item.id} failed:`, e);
      }
    }
  }
}

/** Sends the album, then the draft text. A failed album (too big, odd format) never stops the draft itself. */
export async function deliverDraft(sendAlbum: () => Promise<void>, sendText: (note: string) => Promise<number>): Promise<number> {
  let note = '';
  try {
    await sendAlbum();
  } catch (e) {
    console.error('Sending the photo album failed:', e);
    note = "(The photos couldn't be sent here; they're still in the listing.)";
  }
  return sendText(note);
}

export const REDRAFT_MESSAGE = "The bot restarted while drafting this one. Please post it again in #new-listing.";

/**
 * After a restart, nothing is still running. An item left in 'posting' may or may not be on eBay, so it goes back
 * to Mom as an error telling her to check eBay first (posting again reuses the same eBay offer, not a duplicate).
 * An item left in 'researching' never reached Mom; the owner is told to post it again.
 */
export async function recoverInterrupted(db: Db): Promise<number[]> {
  const { rows } = await db.query("SELECT id, status FROM items WHERE status IN ('posting', 'researching') ORDER BY id");
  for (const { id, status } of rows) {
    if (status === 'posting' && (await repo.getListings(db, id)).some((l) => l.status === 'live')) {
      // It made it onto eBay; only the status update was lost.
      await repo.setItemStatus(db, id, 'live');
      continue;
    }
    if (status === 'posting') {
      await repo.upsertListing(db, id, 'ebay', {
        externalId: null,
        url: null,
        status: 'error',
        error: 'The bot restarted while posting. Please check eBay to see if it went live before posting again.',
      });
    } else {
      await repo.setItemResearch(db, id, {
        suggestedCents: null,
        lowCents: null,
        highCents: null,
        confidence: 'low',
        comparables: [],
        reasoning: REDRAFT_MESSAGE,
      });
    }
    await repo.setItemStatus(db, id, 'error');
  }
  return rows.map((r) => r.id as number);
}
