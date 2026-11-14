import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import type { Order, Platform } from '../db/repo.js';
import { PLATFORM_LABEL } from '../platforms/types.js';
import { detectCarrier, normalizeTracking } from '../shipping/detectCarrier.js';

export type ShipResult = 'shipped' | 'already' | 'tracking-added';

export interface ShipDeps {
  db: Db;
  /** Tells the marketplace the order shipped, with tracking when there is a recognised carrier. */
  fulfill: Partial<Record<Platform, (order: Order, tracking: string | null, carrier: string | null) => Promise<void>>>;
  /** Edits the order's #to-ship post with a status line. */
  markDiscord: (order: Order, label: string) => Promise<void>;
  /** Edits Mom's Telegram sale message with a status line. */
  markTelegram: (order: Order, label: string) => Promise<void>;
}

async function tellPlatform(order: Order, tracking: string | null, deps: ShipDeps): Promise<string | null> {
  const fulfill = deps.fulfill[order.platform];
  if (!fulfill) return null;
  const carrier = tracking ? detectCarrier(tracking) : null;
  try {
    await fulfill(order, carrier ? tracking : null, carrier);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

async function safely(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    console.error('Could not update a shipping message:', e);
  }
}

/** The single path for marking an order shipped, used by Mom's Telegram button, her replies, and 📦 in Discord. */
export async function markShipped(
  orderId: number,
  by: 'mom' | 'owner',
  rawTracking: string | null,
  deps: ShipDeps,
): Promise<ShipResult> {
  const tracking = rawTracking ? normalizeTracking(rawTracking) : null;
  const before = await repo.getOrder(deps.db, orderId);
  if (!before) return 'already';

  let result: ShipResult;
  if (await repo.markOrderShippedRow(deps.db, orderId, by, tracking)) {
    result = 'shipped';
  } else if (tracking && !before.tracking && (await repo.setOrderTrackingIfMissing(deps.db, orderId, tracking))) {
    result = 'tracking-added';
  } else {
    return 'already';
  }

  const order = (await repo.getOrder(deps.db, orderId))!;
  // A new shipment always tells the platform; adding tracking later only matters when the carrier is known.
  const needsCall = result === 'shipped' || (tracking !== null && detectCarrier(tracking) !== null);
  const uploadError = needsCall ? await tellPlatform(order, tracking, deps) : null;

  const who = order.shippedBy === 'mom' ? 'Mom' : 'you';
  let discordLabel = `📦 Shipped (by ${who})`;
  let momLabel = '✅ Shipped';
  if (order.tracking) {
    discordLabel += ` · tracking ${order.tracking}`;
    momLabel += ` · tracking ${order.tracking}`;
  }
  if (uploadError) {
    const platform = PLATFORM_LABEL[order.platform];
    discordLabel += ` · ⚠️ couldn't update ${platform}: ${uploadError}`;
    momLabel += ` (couldn't update ${platform}: ${uploadError})`;
  }

  await safely(() => deps.markDiscord(order, discordLabel));
  await safely(() => deps.markTelegram(order, momLabel));
  return result;
}
