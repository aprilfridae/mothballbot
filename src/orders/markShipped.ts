import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import type { Order, Platform } from '../db/repo.js';
import { detectCarrier, normalizeTracking } from '../shipping/detectCarrier.js';

export type ShipResult = 'shipped' | 'already' | 'tracking-added';

export interface ShipDeps {
  db: Db;
  uploadTracking: Partial<
    Record<Platform, (order: Order, tracking: string, carrier: string) => Promise<void>>
  >;
  /** Edits the order's #to-ship post with a status line. */
  markDiscord: (order: Order, label: string) => Promise<void>;
  /** Edits Mom's Telegram sale message with a status line. */
  markTelegram: (order: Order, label: string) => Promise<void>;
}

async function pushTracking(order: Order, tracking: string, deps: ShipDeps): Promise<string | null> {
  const carrier = detectCarrier(tracking);
  const upload = deps.uploadTracking[order.platform];
  if (!carrier || !upload) return null;
  try {
    await upload(order, tracking, carrier);
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
  const uploadError = tracking ? await pushTracking(order, tracking, deps) : null;

  const who = order.shippedBy === 'mom' ? 'Mom' : 'you';
  let discordLabel = `📦 Shipped (by ${who})`;
  let momLabel = '✅ Shipped';
  if (order.tracking) {
    discordLabel += ` · tracking ${order.tracking}`;
    momLabel += ` · tracking ${order.tracking}`;
  }
  if (uploadError) {
    discordLabel += ` · ⚠️ couldn't add tracking to eBay: ${uploadError}`;
    momLabel += ` (couldn't add tracking to eBay: ${uploadError})`;
  }

  await safely(() => deps.markDiscord(order, discordLabel));
  await safely(() => deps.markTelegram(order, momLabel));
  return result;
}
