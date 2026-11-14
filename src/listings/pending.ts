import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import type { Item } from '../db/repo.js';

const DRAFTS_WARNED = 'telegram.draftsWarned';

/** Sends Mom every draft waiting on her that she hasn't received (e.g. made before she connected). */
export async function sendPendingDrafts(deps: {
  db: Db;
  sendDraftToMom: (item: Item) => Promise<number | null>;
  report: (text: string) => Promise<void>;
}): Promise<void> {
  const pending = await repo.itemsAwaitingMomWithoutTelegram(deps.db);
  for (const item of pending) {
    const messageId = await deps.sendDraftToMom(item);
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
  }
  if (pending.length) await repo.deleteSetting(deps.db, DRAFTS_WARNED);
}

/**
 * An item left in 'posting' means the bot stopped mid-upload. It may or may not be on eBay, so hand it back to
 * Mom as an error telling her to check eBay first (posting again would reuse the same eBay offer, not duplicate it).
 */
export async function recoverInterruptedPosts(db: Db): Promise<number[]> {
  const { rows } = await db.query("SELECT id FROM items WHERE status = 'posting'");
  const ids = rows.map((r) => r.id as number);
  for (const id of ids) {
    await repo.upsertListing(db, id, 'ebay', {
      externalId: null,
      url: null,
      status: 'error',
      error: 'The bot restarted while posting. Please check eBay to see if it went live before posting again.',
    });
    await repo.setItemStatus(db, id, 'error');
  }
  return ids;
}
