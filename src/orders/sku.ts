/** Listings the bot creates use SKU `item-<id>`; this finds the item (and its photos) behind a sale. */
export function itemIdFromSku(sku: string | null | undefined): number | null {
  const m = sku?.match(/^item-(\d+)$/);
  return m ? Number(m[1]) : null;
}

import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';

/** The sold item's first photo Telegram can show, so Mom sees what to pack. */
export async function salePhoto(db: Db, sku: string | null | undefined): Promise<string | null> {
  const id = itemIdFromSku(sku);
  if (id === null) return null;
  const item = await repo.getItem(db, id);
  return item?.photos.find((p) => /\.(jpe?g|png|webp)$/i.test(p)) ?? null;
}
