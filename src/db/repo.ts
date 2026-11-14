import type { Db } from './db.js';

export type Platform = 'ebay' | 'etsy' | 'facebook';

export type ItemStatus = 'researching' | 'awaiting_mom' | 'posting' | 'live' | 'rejected' | 'error';

export interface PriceResearch {
  suggestedCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  confidence: 'low' | 'medium' | 'high';
  comparables: { title: string; priceCents: number; sold: boolean; site: string; url: string }[];
  reasoning: string;
  /** Set when the research service itself failed (not just "nothing found"); the raw error for #bot-status. */
  error?: string;
}

export interface Item {
  id: number;
  title: string;
  details: string;
  priceCents: number | null;
  photos: string[];
  draft: unknown | null;
  status: ItemStatus;
  research: PriceResearch | null;
  discordMessageId: string | null;
  telegramMessageId: number | null;
}

export interface ListingRow {
  platform: Platform;
  externalId: string | null;
  url: string | null;
  status: 'live' | 'error';
  error: string | null;
}

export interface Conversation {
  id: number;
  platform: Platform;
  externalId: string;
  buyerUsername: string;
  discordThreadId: string | null;
}

export interface ShipTo {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  /** Two-letter country code; shown only when it isn't US. */
  country?: string;
}

export interface OrderData {
  itemTitle: string;
  buyer: string;
  shipTo: ShipTo | null;
  localPickup: boolean;
  shipBy: Date | null;
  lineItemIds?: string[];
  sku?: string | null;
}

export interface Order extends OrderData {
  id: number;
  platform: Platform;
  externalId: string;
  lineItemIds: string[];
  discordMessageId: string | null;
  telegramMessageId: number | null;
  shippedAt: Date | null;
  shippedBy: 'mom' | 'owner' | null;
  tracking: string | null;
  sku: string | null;
  /** Last error telling the marketplace it shipped (so a later tracking reply can retry). */
  fulfillError: string | null;
}

const toItem = (r: any): Item => ({
  id: r.id,
  title: r.title,
  details: r.details,
  priceCents: r.price_cents,
  photos: r.photos,
  draft: r.draft,
  status: r.status,
  research: r.research,
  discordMessageId: r.discord_message_id,
  telegramMessageId: r.telegram_message_id === null ? null : Number(r.telegram_message_id),
});

const toConversation = (r: any): Conversation => ({
  id: r.id,
  platform: r.platform,
  externalId: r.external_id,
  buyerUsername: r.buyer_username,
  discordThreadId: r.discord_thread_id,
});

const toOrder = (r: any): Order => ({
  id: r.id,
  platform: r.platform,
  externalId: r.external_id,
  itemTitle: r.item_title,
  buyer: r.buyer,
  shipTo: r.ship_to,
  localPickup: r.local_pickup,
  shipBy: r.ship_by,
  lineItemIds: r.line_item_ids,
  discordMessageId: r.discord_message_id,
  telegramMessageId: r.telegram_message_id === null ? null : Number(r.telegram_message_id),
  shippedAt: r.shipped_at,
  shippedBy: r.shipped_by,
  tracking: r.tracking,
  sku: r.sku ?? null,
  fulfillError: r.fulfill_error ?? null,
});

export async function insertItem(
  db: Db,
  i: { title: string; details: string; priceCents: number | null; photos: string[] },
): Promise<Item> {
  const { rows } = await db.query(
    'INSERT INTO items (title, details, price_cents, photos) VALUES ($1, $2, $3, $4) RETURNING *',
    [i.title, i.details, i.priceCents, JSON.stringify(i.photos)],
  );
  return toItem(rows[0]);
}

export async function getItem(db: Db, id: number): Promise<Item | null> {
  const { rows } = await db.query('SELECT * FROM items WHERE id = $1', [id]);
  return rows[0] ? toItem(rows[0]) : null;
}

export async function updateItemDraft(db: Db, id: number, draft: unknown): Promise<void> {
  await db.query('UPDATE items SET draft = $2 WHERE id = $1', [id, JSON.stringify(draft)]);
}

export async function updateItemPrice(db: Db, id: number, priceCents: number | null): Promise<void> {
  await db.query('UPDATE items SET price_cents = $2 WHERE id = $1', [id, priceCents]);
}

export async function setItemDiscordMessage(db: Db, id: number, messageId: string): Promise<void> {
  await db.query('UPDATE items SET discord_message_id = $2 WHERE id = $1', [id, messageId]);
}

export async function setItemStatus(db: Db, id: number, status: ItemStatus): Promise<void> {
  await db.query('UPDATE items SET status = $2 WHERE id = $1', [id, status]);
}

/** Atomically moves an item to `to` only if it is currently in one of `from`; false if someone else got there first. */
export async function transitionItemStatus(db: Db, id: number, from: ItemStatus[], to: ItemStatus): Promise<boolean> {
  const { rowCount } = await db.query('UPDATE items SET status = $3 WHERE id = $1 AND status = ANY($2)', [id, from, to]);
  return rowCount === 1;
}

export async function setItemResearch(db: Db, id: number, research: PriceResearch): Promise<void> {
  await db.query('UPDATE items SET research = $2 WHERE id = $1', [id, JSON.stringify(research)]);
}

export async function setItemTelegramMessage(db: Db, id: number, messageId: number): Promise<void> {
  await db.query('UPDATE items SET telegram_message_id = $2 WHERE id = $1', [id, messageId]);
}

export async function findItemByTelegramMessage(db: Db, messageId: number): Promise<Item | null> {
  const { rows } = await db.query('SELECT * FROM items WHERE telegram_message_id = $1', [messageId]);
  return rows[0] ? toItem(rows[0]) : null;
}

export async function itemsAwaitingMomWithoutTelegram(db: Db): Promise<Item[]> {
  const { rows } = await db.query(
    "SELECT * FROM items WHERE status = 'awaiting_mom' AND telegram_message_id IS NULL ORDER BY id",
  );
  return rows.map(toItem);
}

export async function upsertListing(
  db: Db,
  itemId: number,
  platform: Platform,
  l: Omit<ListingRow, 'platform'>,
): Promise<void> {
  await db.query(
    `INSERT INTO listings (item_id, platform, external_id, url, status, error)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (item_id, platform) DO UPDATE
       SET external_id = EXCLUDED.external_id, url = EXCLUDED.url,
           status = EXCLUDED.status, error = EXCLUDED.error
       WHERE listings.status <> 'live' OR EXCLUDED.status = 'live'`,
    [itemId, platform, l.externalId, l.url, l.status, l.error],
  );
}

export async function getListings(db: Db, itemId: number): Promise<ListingRow[]> {
  const { rows } = await db.query(
    'SELECT platform, external_id, url, status, error FROM listings WHERE item_id = $1 ORDER BY platform',
    [itemId],
  );
  return rows.map((r) => ({
    platform: r.platform,
    externalId: r.external_id,
    url: r.url,
    status: r.status,
    error: r.error,
  }));
}

export async function upsertConversation(
  db: Db,
  platform: Platform,
  externalId: string,
  buyerUsername: string,
): Promise<Conversation> {
  const { rows } = await db.query(
    `INSERT INTO conversations (platform, external_id, buyer_username)
     VALUES ($1, $2, $3)
     ON CONFLICT (platform, external_id) DO UPDATE SET buyer_username = EXCLUDED.buyer_username
     RETURNING *`,
    [platform, externalId, buyerUsername],
  );
  return toConversation(rows[0]);
}

export async function setConversationThread(db: Db, id: number, threadId: string): Promise<void> {
  await db.query('UPDATE conversations SET discord_thread_id = $2 WHERE id = $1', [id, threadId]);
}

export async function findConversationByThread(db: Db, threadId: string): Promise<Conversation | null> {
  const { rows } = await db.query('SELECT * FROM conversations WHERE discord_thread_id = $1', [threadId]);
  return rows[0] ? toConversation(rows[0]) : null;
}

export async function messageExists(db: Db, externalId: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM messages WHERE external_id = $1', [externalId]);
  return rowCount === 1;
}

export async function insertMessageIfNew(
  db: Db,
  conversationId: number,
  externalId: string,
  fromBuyer: boolean,
  body: string,
  sentAt: Date,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO messages (conversation_id, external_id, from_buyer, body, sent_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (external_id) DO NOTHING`,
    [conversationId, externalId, fromBuyer, body, sentAt],
  );
  return rowCount === 1;
}

export async function insertOrderIfNew(
  db: Db,
  platform: Platform,
  externalId: string,
  d: OrderData,
): Promise<Order | null> {
  const { rows } = await db.query(
    `INSERT INTO orders (platform, external_id, item_title, buyer, ship_to, local_pickup, ship_by, line_item_ids, sku)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (platform, external_id) DO NOTHING RETURNING *`,
    [
      platform,
      externalId,
      d.itemTitle,
      d.buyer,
      d.shipTo ? JSON.stringify(d.shipTo) : null,
      d.localPickup,
      d.shipBy,
      JSON.stringify(d.lineItemIds ?? []),
      d.sku ?? null,
    ],
  );
  return rows[0] ? toOrder(rows[0]) : null;
}

export async function getOrder(db: Db, id: number): Promise<Order | null> {
  const { rows } = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
  return rows[0] ? toOrder(rows[0]) : null;
}

export async function setOrderTelegramMessage(db: Db, id: number, messageId: number): Promise<void> {
  await db.query('UPDATE orders SET telegram_message_id = $2 WHERE id = $1', [id, messageId]);
}

export async function setOrderDiscordMessage(db: Db, id: number, messageId: string): Promise<void> {
  await db.query('UPDATE orders SET discord_message_id = $2 WHERE id = $1', [id, messageId]);
}

export async function findOrderByTelegramMessage(db: Db, messageId: number): Promise<Order | null> {
  const { rows } = await db.query('SELECT * FROM orders WHERE telegram_message_id = $1', [messageId]);
  return rows[0] ? toOrder(rows[0]) : null;
}

export async function findOrderByDiscordMessage(db: Db, messageId: string): Promise<Order | null> {
  const { rows } = await db.query('SELECT * FROM orders WHERE discord_message_id = $1', [messageId]);
  return rows[0] ? toOrder(rows[0]) : null;
}

export async function markOrderShippedRow(
  db: Db,
  orderId: number,
  by: 'mom' | 'owner',
  tracking: string | null,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE orders SET shipped_at = now(), shipped_by = $2, tracking = $3
     WHERE id = $1 AND shipped_at IS NULL`,
    [orderId, by, tracking],
  );
  return rowCount === 1;
}

export async function setOrderTrackingIfMissing(db: Db, orderId: number, tracking: string): Promise<boolean> {
  const { rowCount } = await db.query('UPDATE orders SET tracking = $2 WHERE id = $1 AND tracking IS NULL', [
    orderId,
    tracking,
  ]);
  return rowCount === 1;
}

export async function unshippedOrdersWithoutTelegram(db: Db): Promise<Order[]> {
  const { rows } = await db.query(
    'SELECT * FROM orders WHERE telegram_message_id IS NULL AND shipped_at IS NULL ORDER BY id',
  );
  return rows.map(toOrder);
}

export async function setOrderTracking(db: Db, orderId: number, tracking: string): Promise<void> {
  await db.query('UPDATE orders SET tracking = $2 WHERE id = $1', [orderId, tracking]);
}

export async function setOrderFulfillError(db: Db, orderId: number, error: string | null): Promise<void> {
  await db.query('UPDATE orders SET fulfill_error = $2 WHERE id = $1', [orderId, error]);
}

export async function findOrderByExternal(db: Db, platform: Platform, externalId: string): Promise<Order | null> {
  const { rows } = await db.query('SELECT * FROM orders WHERE platform = $1 AND external_id = $2', [platform, externalId]);
  return rows[0] ? toOrder(rows[0]) : null;
}

export async function getSetting(db: Db, key: string): Promise<string | null> {
  const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function deleteSetting(db: Db, key: string): Promise<void> {
  await db.query('DELETE FROM settings WHERE key = $1', [key]);
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value],
  );
}
