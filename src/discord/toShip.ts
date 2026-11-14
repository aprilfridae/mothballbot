import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import type { Order, Platform } from '../db/repo.js';
import type { ShipResult } from '../orders/markShipped.js';
import { PLATFORM_LABEL, type PlatformOrder } from '../platforms/types.js';
import { formatAddress, formatShipBy } from '../telegram/momBot.js';

export interface AnnounceDeps {
  db: Db;
  /** Posts to #to-ship; returns the Discord message id. */
  postToShip: (text: string) => Promise<string>;
  /** Posts to #sales. */
  postSale: (text: string) => Promise<void>;
  /** Sends to Mom on Telegram; returns the message id, or null if she isn't reachable yet. */
  notifyMom: (order: Order) => Promise<number | null>;
}

export function formatToShip(o: Order): string {
  const lines = [`**${o.itemTitle}** · sold on ${PLATFORM_LABEL[o.platform]} to ${o.buyer}`];
  if (o.localPickup || !o.shipTo) lines.push('Local pickup');
  else lines.push('```', formatAddress(o.shipTo), '```');
  if (o.shipBy) lines.push(`Ship by **${formatShipBy(o.shipBy)}**`);
  lines.push('React 📦 when shipped.');
  return lines.join('\n');
}

/**
 * Records new sales and announces each one exactly once per destination. Anything that failed to send
 * (e.g. Mom not connected yet) is retried on the next poll while the order is unshipped.
 */
export async function announceOrders(platform: Platform, orders: PlatformOrder[], deps: AnnounceDeps): Promise<void> {
  for (const po of orders) {
    const order =
      (await repo.insertOrderIfNew(deps.db, platform, po.externalId, po)) ??
      (await repo.findOrderByExternal(deps.db, platform, po.externalId));
    if (!order || order.shippedAt) continue;

    if (!order.discordMessageId) {
      const id = await deps.postToShip(formatToShip(order));
      await repo.setOrderDiscordMessage(deps.db, order.id, id);
      await deps.postSale(`💰 Sold on ${PLATFORM_LABEL[platform]}: ${order.itemTitle}`);
    }
    if (order.telegramMessageId === null) {
      const tg = await deps.notifyMom(order);
      if (tg !== null) await repo.setOrderTelegramMessage(deps.db, order.id, tg);
    }
  }
}

export async function handleToShipReaction(
  messageId: string,
  emoji: string,
  deps: { db: Db; markShipped: (orderId: number, by: 'owner', tracking: null) => Promise<ShipResult> },
): Promise<void> {
  if (emoji !== '📦') return;
  const order = await repo.findOrderByDiscordMessage(deps.db, messageId);
  if (order) await deps.markShipped(order.id, 'owner', null);
}
